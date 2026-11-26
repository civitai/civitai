import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuditModule from '~/utils/metadata/audit';

/**
 * When the external prompt classifier cannot answer (gateway error, timeout), the prompt has only
 * been checked by the local word lists. A submit that would otherwise go through must fail CLOSED
 * as a retry-able 503 — never submitted, never counted toward the user's blocks — instead of
 * proceeding on the word lists alone.
 */

const { mockAuditPromptEnriched, mockModeratePrompt, mockProhibited } = vi.hoisted(() => ({
  mockAuditPromptEnriched: vi.fn(),
  mockModeratePrompt: vi.fn(async () => ({ flagged: false, categories: [] as string[] })),
  mockProhibited: vi.fn(),
}));

vi.mock('~/utils/metadata/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof AuditModule>()),
  auditPromptEnriched: mockAuditPromptEnriched,
}));
vi.mock('~/server/integrations/moderation', () => ({
  extModeration: { moderatePrompt: mockModeratePrompt },
}));
vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: vi.fn(async (text?: string) => text),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ updateUserById: vi.fn(async () => undefined) }));
vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/user-restriction.service', () => ({
  applyPendingReviewMute: vi.fn(async () => ({ muted: false })),
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn(),
  bustFetchThroughCache: vi.fn(),
}));

import type { PromptTrigger } from '~/utils/metadata/audit';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import { PromptCheckUnavailableError } from '~/server/services/orchestrator/prompt-check-unavailable';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

const UNAVAILABLE = 'The prompt check is temporarily unavailable. Please try again in a moment.';

// `daughter` is a real soft-tier blocklist entry; a `poi` trigger is hard.
const SOFT: PromptTrigger = {
  category: 'nsfw_blocklist',
  message: 'daughter',
  matchedWord: 'daughter',
};
const HARD: PromptTrigger = {
  category: 'poi',
  message: 'Prompt cannot include celebrity names',
  matchedWord: 'celebrity',
};

const options = {
  prompt: 'a lighthouse at dusk',
  userId: 5,
  isGreen: false,
  track: { prohibitedRequest: mockProhibited },
};

const flagWith = (...triggers: PromptTrigger[]) =>
  mockAuditPromptEnriched.mockReturnValue({
    blockedFor: triggers.map((t) => t.message),
    triggers,
    success: false,
  });

const classifierDown = () =>
  mockModeratePrompt.mockRejectedValue(new Error('External moderation failed: 503'));

/** Assert nothing was recorded against the user: no counter write, no audit row. */
const expectNotCounted = () => {
  expect(redisMock.sysRedis.lPush).not.toHaveBeenCalled();
  expect(mockProhibited).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  mockModeratePrompt.mockReset();
  mockModeratePrompt.mockResolvedValue({ flagged: false, categories: [] });
  mockAuditPromptEnriched.mockReturnValue({ blockedFor: [], triggers: [], success: true });
  // The blocked-prompt list exists, so a counted block appends to it rather than re-seeding.
  redisMock.sysRedis.exists.mockResolvedValue(1);
  resetEnv();
});

describe('auditPromptServer — external classifier unavailable', () => {
  it('refuses a clean prompt with a 503 instead of passing it on the word lists alone', async () => {
    classifierDown();
    const error = await auditPromptServer(options).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: UNAVAILABLE });
    // Its own class, which is what lets a caller tell it from the orchestrator's 503s.
    expect(error).toBeInstanceOf(PromptCheckUnavailableError);
    expect(mockModeratePrompt).toHaveBeenCalledTimes(1);
    expectNotCounted();
  });

  it('refuses a moderator too: the check is a moderation control, not a user limit', async () => {
    classifierDown();
    await expect(auditPromptServer({ ...options, isModerator: true })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('refuses an ACKNOWLEDGED soft block: the acknowledgement never skips the classifier', async () => {
    flagWith(SOFT);
    classifierDown();
    await expect(
      auditPromptServer({ ...options, acknowledgedSoftBlock: true })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: UNAVAILABLE });
    expectNotCounted();
  });

  // Invariant guards: these refused before this change and must keep their own verdict.
  it('INVARIANT: an unacknowledged soft block keeps its overridable refusal', async () => {
    flagWith(SOFT);
    classifierDown();
    const error = await auditPromptServer(options).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as { cause?: { softBlock?: boolean } }).cause?.softBlock).toBe(true);
  });

  it('INVARIANT: a hard regex block is still the hard block (the classifier is never asked)', async () => {
    flagWith(HARD);
    classifierDown();
    await expect(auditPromptServer(options)).rejects.toThrow(/celebrity/);
    expect(mockModeratePrompt).not.toHaveBeenCalled();
    // Positive control for `expectNotCounted`: a counted block IS seen by the same probes.
    expect(redisMock.sysRedis.lPush).toHaveBeenCalled();
    expect(mockProhibited).toHaveBeenCalled();
  });

  it('PROMPT_CHECK_FAIL_CLOSED off: a classifier error passes the prompt through, as before', async () => {
    setEnv({ PROMPT_CHECK_FAIL_CLOSED: false });
    classifierDown();
    await expect(auditPromptServer(options)).resolves.toBeUndefined();
    expect(mockModeratePrompt).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'external-moderation-error' })
    );
  });

  it('PROMPT_CHECK_FAIL_CLOSED off: an acknowledged soft block proceeds on a classifier error', async () => {
    setEnv({ PROMPT_CHECK_FAIL_CLOSED: false });
    flagWith(SOFT);
    classifierDown();
    await expect(
      auditPromptServer({ ...options, acknowledgedSoftBlock: true })
    ).resolves.toBeUndefined();
  });

  it('CONTROL: a classifier that answers "not flagged" lets the prompt through', async () => {
    await expect(auditPromptServer(options)).resolves.toBeUndefined();
    expect(mockModeratePrompt).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: an acknowledged soft block the classifier clears still proceeds', async () => {
    flagWith(SOFT);
    await expect(
      auditPromptServer({ ...options, acknowledgedSoftBlock: true })
    ).resolves.toBeUndefined();
  });
});
