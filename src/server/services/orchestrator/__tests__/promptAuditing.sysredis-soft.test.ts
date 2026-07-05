import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * STEP-6 sysRedis soft-dependency (Group C) — promptAuditing.
 *
 * SAFETY-SENSITIVE. The sysRedis reads in `addBlockedPrompt` (exists / lRange /
 * lLen) run AFTER a prompt has already been flagged, on the way to the
 * violation-count → auto-mute accounting inside `auditPromptServer`. They must
 * keep FAILING CLOSED: a sysRedis error propagates out of auditPromptServer so
 * the generation request errors rather than silently proceeding. STEP-6 only
 * adds the wall-clock deadline to BOUND a silent half-open (it would otherwise
 * park each awaited read ~11min) — it deliberately does NOT add a fail-open
 * catch. This suite locks in "park bounded, but still fails closed":
 *   - the deadline wrap is applied (SLOW → rejects at the deadline rather than
 *     hanging → fail-on-revert), AND
 *   - the error still propagates (no silent success), AND
 *   - no fail-open is logged (there is no fail-open here by design).
 */

const {
  mockExists,
  mockLPush,
  mockLRange,
  mockLRem,
  mockLLen,
  mockWithSysReadDeadline,
  mockLogSysRedisFailOpen,
  mockAuditPromptEnriched,
  mockModeratePrompt,
} = vi.hoisted(() => ({
  mockExists: vi.fn(),
  mockLPush: vi.fn(async () => 1),
  mockLRange: vi.fn(async () => [] as string[]),
  mockLRem: vi.fn(async () => 1),
  mockLLen: vi.fn(async () => 1),
  mockWithSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
  mockLogSysRedisFailOpen: vi.fn(),
  mockAuditPromptEnriched: vi.fn(),
  mockModeratePrompt: vi.fn(async () => ({ flagged: false, categories: [] as string[] })),
}));

vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: {},
    sysRedis: {
      exists: mockExists,
      lPush: mockLPush,
      lRange: mockLRange,
      lRem: mockLRem,
      lLen: mockLLen,
      del: vi.fn(),
      expire: vi.fn(),
      rPush: vi.fn(),
    },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    withSysReadDeadline: mockWithSysReadDeadline,
  };
});
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: mockLogSysRedisFailOpen }));

// Force the regex audit to flag the prompt so auditPromptServer enters its catch
// and reaches addBlockedPrompt (the reads under test).
vi.mock('~/utils/metadata/audit', () => ({
  auditPromptEnriched: mockAuditPromptEnriched,
}));
vi.mock('~/server/integrations/moderation', () => ({
  extModeration: { moderatePrompt: mockModeratePrompt },
}));

// Collapse the heavy graph — none of these are reached on the counting path with
// a below-threshold count.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ updateUserById: vi.fn() }));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn(),
  bustFetchThroughCache: vi.fn(),
}));
// The mute path's banError catch logs via logToAxiom — stub it so the test
// doesn't attempt a real network call.
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));

import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';

const blockingOptions = {
  prompt: 'a flagged prompt',
  userId: 5,
  isGreen: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockWithSysReadDeadline.mockImplementation((p) => p); // transparent by default
  // Regex audit flags the prompt → drives the block path.
  mockAuditPromptEnriched.mockReturnValue({
    triggers: [{ message: 'blocked term', category: 'regex', matchedWord: 'x' }],
    success: false,
  });
  mockExists.mockResolvedValue(1);
  mockLRange.mockResolvedValue([]);
  mockLLen.mockResolvedValue(1); // below the mute threshold — no auto-mute
});

describe('auditPromptServer → addBlockedPrompt — sysRedis reads (fail-CLOSED, park-bounded)', () => {
  it('happy path: flagged prompt → throws the block error, reads wrapped in withSysReadDeadline, no fail-open log', async () => {
    // A flagged prompt always throws a BAD_REQUEST (the user-facing block). The
    // point here is that the counting reads went THROUGH the deadline wrap.
    await expect(auditPromptServer(blockingOptions)).rejects.toThrow();

    // exists + lRange + lLen each wrapped.
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(3);
    // No fail-open here by design — this path fails closed, never fails open.
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: sysRedis.exists throws → the error PROPAGATES (fails closed), no silent success, no fail-open log', async () => {
    mockExists.mockRejectedValue(new Error('sysRedis connection is down'));

    // Must reject with the underlying sysRedis error — NOT resolve. A resolve
    // would mean the counting path swallowed the outage (a moderation weakening).
    await expect(auditPromptServer(blockingOptions)).rejects.toThrow(/down/i);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('SLOW/half-open: exists NEVER settles + deadline REJECTS → the error propagates (fail-on-revert), no fail-open log', async () => {
    mockExists.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    await expect(auditPromptServer(blockingOptions)).rejects.toThrow(/timed out/i);
    // The wrap was applied to the first read (exists). Without it, the bare
    // `await sysRedis.exists` would hang and this test would TIME OUT.
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });
});

describe('auditPromptServer → reportProhibitedRequest → getBlockedPrompts (mute path, fail-CAUGHT)', () => {
  // Drive count > muted (constants.imageGeneration.requestBlocking.muted = 8) so
  // reportProhibitedRequest enters the auto-mute branch and calls getBlockedPrompts.
  // The downstream dbWrite.userRestriction.create throws (dbWrite is mocked {}),
  // absorbed by the existing `catch (banError)` — so no heavy mute-path scaffolding
  // is needed. Unlike addBlockedPrompt (fail-PROPAGATED), a sysRedis error in
  // getBlockedPrompts is fail-CAUGHT: the auto-mute is skipped, and the current
  // prompt is still blocked upstream via throwBadRequestError.
  it('mute path: getBlockedPrompts lRange goes through withSysReadDeadline (4th wrapped read); prompt still blocked', async () => {
    mockLLen.mockResolvedValue(9); // > muted (8) → enters the mute branch

    await expect(auditPromptServer(blockingOptions)).rejects.toThrow();

    // exists + lRange + lLen (addBlockedPrompt) + lRange (getBlockedPrompts) = 4.
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(4);
    // No fail-open branch here — getBlockedPrompts' outcome is handled by banError.
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('SLOW/half-open on getBlockedPrompts: its lRange never settles + deadline REJECTS → caught by banError (mute skipped), prompt still blocked (fail-on-revert)', async () => {
    mockLLen.mockResolvedValue(9); // enter the mute branch
    // addBlockedPrompt's lRange (1st) resolves; getBlockedPrompts' lRange (2nd) never settles.
    mockLRange.mockResolvedValueOnce([]).mockReturnValueOnce(new Promise(() => undefined));
    // Transparent for the three addBlockedPrompt reads; reject the 4th call
    // (getBlockedPrompts lRange) to model the half-open deadline trip.
    mockWithSysReadDeadline
      .mockImplementationOnce((p) => p)
      .mockImplementationOnce((p) => p)
      .mockImplementationOnce((p) => p)
      .mockRejectedValueOnce(new Error('sysRedis read timed out after 2000ms'));

    // The deadline-reject is absorbed by reportProhibitedRequest's banError catch;
    // auditPromptServer still throws the user-facing block. Without the wrap on
    // getBlockedPrompts, the bare `await sysRedis.lRange` would HANG → test times out.
    await expect(auditPromptServer(blockingOptions)).rejects.toThrow();
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(4);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });
});
