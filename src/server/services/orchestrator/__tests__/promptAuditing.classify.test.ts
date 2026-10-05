import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuditModule from '~/utils/metadata/audit';

/**
 * `classifyPromptServer` is the DECISION half of `auditPromptServer`, split out so a caller can
 * ask what the audit would do without it doing anything (shadow moderation). Three things are
 * pinned here:
 *
 * 1. The verdict itself, as LITERAL objects — never derived from the implementation.
 * 2. The ordering the split must not lose: a soft regex block does NOT short-circuit the external
 *    classifier, a hard one does.
 * 3. INVARIANT GUARDS: the classifier performs none of the audit's consequences (no blocked-prompt
 *    counter write, no prohibited-request report, no auto-mute, no Axiom event). These pin a
 *    property the pre-split code never had to hold, so they are not regression tests.
 *
 * And the other side of the split: the wrapper still produces today's side effects, with literal
 * expectations, so the refactor cannot have quietly moved one of them into the pure half.
 *
 * Mock preamble follows `promptAuditing.moderation-source.test.ts` (the redis + logging + db
 * clients come from the canonical mocks registered in setup.ts — do not declare them here).
 */

const {
  mockStripBenignPhrases,
  mockAuditPromptEnriched,
  mockModeratePrompt,
  mockApplyPendingReviewMute,
} = vi.hoisted(() => ({
  mockStripBenignPhrases: vi.fn(async (text?: string) => text),
  mockAuditPromptEnriched: vi.fn(),
  mockModeratePrompt: vi.fn(async () => ({ flagged: false, categories: [] as string[] })),
  mockApplyPendingReviewMute: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: mockStripBenignPhrases,
}));
vi.mock('~/utils/metadata/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof AuditModule>()),
  auditPromptEnriched: mockAuditPromptEnriched,
}));
vi.mock('~/server/integrations/moderation', () => ({
  extModeration: { moderatePrompt: mockModeratePrompt },
}));
vi.mock('~/server/services/user-restriction.service', () => ({
  applyPendingReviewMute: mockApplyPendingReviewMute,
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ updateUserById: vi.fn() }));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn(),
  bustFetchThroughCache: vi.fn(),
}));

import type { PromptTrigger, PromptTriggerCategory } from '~/utils/metadata/audit';
import {
  auditPromptServer,
  classifyPromptServer,
} from '~/server/services/orchestrator/promptAuditing';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const sysRedis = redisMock.sysRedis;
const logToAxiom = loggingMock.logToAxiom;

// `daughter` is a real soft-tier blocklist entry; `rape` and `poi` are hard. Severity is per word.
const trigger = (category: PromptTriggerCategory, message: string): PromptTrigger => ({
  category,
  message,
  matchedWord: message,
});
const SOFT = trigger('nsfw_blocklist', 'daughter');
const HARD = trigger('poi', 'Prompt cannot include celebrity names');

const flagWith = (...triggers: PromptTrigger[]) =>
  mockAuditPromptEnriched.mockReturnValue({
    blockedFor: triggers.map((t) => t.message),
    triggers,
    success: false,
  });

const externalFlags = (...categories: string[]) =>
  mockModeratePrompt.mockResolvedValueOnce({ flagged: true, categories });

const PROMPT = 'a quiet harbour at dusk';

/** Every sysRedis command the blocked-prompt store and the auto-mute path issue. */
const STORE_COMMANDS = ['exists', 'lPush', 'rPush', 'lRange', 'lRem', 'lLen', 'del', 'expire'];

const expectNoSideEffects = () => {
  for (const command of STORE_COMMANDS) {
    expect(sysRedis[command], `sysRedis.${command}`).not.toHaveBeenCalled();
  }
  expect(logToAxiom).not.toHaveBeenCalled();
  expect(mockApplyPendingReviewMute).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditPromptEnriched.mockReturnValue({ blockedFor: [], triggers: [], success: true });
  // `mockReset`, not just the clear above: a `mockResolvedValueOnce` a failing test never consumed
  // would otherwise leak into the next test and fail it for the wrong reason.
  mockModeratePrompt.mockReset();
  mockModeratePrompt.mockResolvedValue({ flagged: false, categories: [] });
  // An existing counter key with one entry, so the wrapper's addBlockedPrompt never seeds.
  sysRedis.exists.mockResolvedValue(1);
  sysRedis.lRange.mockResolvedValue([]);
  sysRedis.lLen.mockResolvedValue(1);
});

describe('classifyPromptServer — the verdict', () => {
  it('passes clean text, with the external classifier consulted', async () => {
    await expect(classifyPromptServer({ prompt: PROMPT, isGreen: true })).resolves.toEqual({
      outcome: 'pass',
      source: null,
      triggers: [],
      blockedFor: [],
      categories: [],
      externalError: null,
    });
    expect(mockModeratePrompt).toHaveBeenCalledTimes(1);
  });

  it('a hard regex block is the verdict and SKIPS the external classifier', async () => {
    flagWith(HARD);
    await expect(classifyPromptServer({ prompt: PROMPT, isGreen: false })).resolves.toEqual({
      outcome: 'hard',
      source: 'regex',
      triggers: [HARD],
      blockedFor: ['Prompt cannot include celebrity names'],
      categories: [],
      externalError: null,
    });
    expect(mockModeratePrompt).not.toHaveBeenCalled();
  });

  /** MUTATION TARGET: short-circuit on a soft regex block and this goes red. */
  it('a soft regex block does NOT short-circuit the external classifier', async () => {
    flagWith(SOFT);
    await expect(classifyPromptServer({ prompt: PROMPT, isGreen: false })).resolves.toEqual({
      outcome: 'soft',
      source: 'regex',
      triggers: [SOFT],
      blockedFor: ['daughter'],
      categories: [],
      externalError: null,
    });
    expect(mockModeratePrompt).toHaveBeenCalledTimes(1);
  });

  /** MUTATION TARGET as well: a short-circuit would return the SOFT verdict here. */
  it('an external flag escalates a held soft regex block to a hard external one', async () => {
    flagWith(SOFT);
    externalFlags('sexual/minors');
    await expect(classifyPromptServer({ prompt: PROMPT, isGreen: false })).resolves.toEqual({
      outcome: 'hard',
      source: 'external',
      triggers: [{ category: 'external', message: 'sexual/minors', matchedWord: 'sexual/minors' }],
      blockedFor: ['sexual/minors'],
      categories: ['sexual/minors'],
      externalError: null,
    });
  });

  it('an external flag on otherwise-clean text is a hard external verdict', async () => {
    externalFlags('violence', 'harassment');
    const verdict = await classifyPromptServer({ prompt: PROMPT, isGreen: true });
    expect(verdict).toMatchObject({
      outcome: 'hard',
      source: 'external',
      blockedFor: ['violence', 'harassment'],
      categories: ['violence', 'harassment'],
    });
  });

  it('an external flag with NO categories is not a block (unchanged pre-split behaviour)', async () => {
    externalFlags();
    await expect(classifyPromptServer({ prompt: PROMPT, isGreen: true })).resolves.toMatchObject({
      outcome: 'pass',
      source: null,
    });
  });

  it('the external classifier fails OPEN and the failure is carried, not logged', async () => {
    mockModeratePrompt.mockRejectedValueOnce(new Error('classifier down'));
    await expect(classifyPromptServer({ prompt: PROMPT, isGreen: true })).resolves.toEqual({
      outcome: 'pass',
      source: null,
      triggers: [],
      blockedFor: [],
      categories: [],
      externalError: { message: 'classifier down' },
    });
  });

  it('a failed-open classifier leaves a held soft block as the verdict', async () => {
    flagWith(SOFT);
    mockModeratePrompt.mockRejectedValueOnce(new Error('classifier down'));
    await expect(classifyPromptServer({ prompt: PROMPT, isGreen: false })).resolves.toMatchObject({
      outcome: 'soft',
      source: 'regex',
      externalError: { message: 'classifier down' },
    });
  });

  it('an empty prompt passes without reading anything, as the audit skips it', async () => {
    await expect(classifyPromptServer({ prompt: '   ', isGreen: true })).resolves.toMatchObject({
      outcome: 'pass',
    });
    expect(mockStripBenignPhrases).not.toHaveBeenCalled();
    expect(mockModeratePrompt).not.toHaveBeenCalled();
  });

  it('audits with the green-only list exactly when isGreen', async () => {
    await classifyPromptServer({ prompt: PROMPT, isGreen: true });
    await classifyPromptServer({ prompt: PROMPT, isGreen: false });
    expect(mockAuditPromptEnriched.mock.calls.map((c) => c[2])).toEqual([true, false]);
  });
});

describe('classifyPromptServer — INVARIANT GUARDS: no side effects on any verdict', () => {
  const scenarios: Array<[string, () => void]> = [
    ['pass', () => undefined],
    ['hard regex', () => flagWith(HARD)],
    ['soft regex', () => flagWith(SOFT)],
    ['hard external', () => externalFlags('violence')],
    ['external failure', () => mockModeratePrompt.mockRejectedValueOnce(new Error('down'))],
  ];

  it.each(scenarios)(
    '%s: no counter write, no report, no mute, no Axiom event',
    async (_, arrange) => {
      arrange();
      // Not green: green is the branch that records nothing even in the wrapper, so it would make
      // this guard pass for the wrong reason.
      await classifyPromptServer({ prompt: PROMPT, isGreen: false });
      expectNoSideEffects();
    }
  );

  /** Positive control: the same scenario through the WRAPPER does write, so the guard can see. */
  it('positive control — the wrapper on a hard regex block DOES write the counter', async () => {
    flagWith(HARD);
    await auditPromptServer({ prompt: PROMPT, userId: 9, isGreen: false }).catch(() => undefined);
    expect(sysRedis.lPush).toHaveBeenCalledTimes(1);
  });
});

describe('auditPromptServer — still produces today’s side effects', () => {
  const track = { prohibitedRequest: vi.fn(async () => undefined), userActivity: vi.fn() };
  const base = {
    prompt: PROMPT,
    negativePrompt: 'blurry',
    userId: 9,
    track,
    remixOfId: 11,
    inputImages: ['img-a'],
    inputVideo: 'vid-a',
  };

  it('non-green hard regex: counter write, prohibited-request report, plain message', async () => {
    flagWith(HARD);
    await expect(auditPromptServer({ ...base, isGreen: false })).rejects.toThrow(
      /^Your prompt was flagged: Prompt cannot include celebrity names$/
    );

    expect(sysRedis.lPush).toHaveBeenCalledTimes(1);
    const [, entryJson] = sysRedis.lPush.mock.calls[0] as [string, string];
    expect(JSON.parse(entryJson)).toEqual({
      prompt: PROMPT,
      negativePrompt: 'blurry',
      source: 'Regex',
      category: 'poi',
      matchedWord: 'Prompt cannot include celebrity names',
      imageId: null,
      remixOfId: 11,
      inputImages: ['img-a'],
      inputVideo: 'vid-a',
      time: expect.any(String),
    });
    expect(track.prohibitedRequest).toHaveBeenCalledTimes(1);
    expect(track.prohibitedRequest).toHaveBeenCalledWith({
      prompt: PROMPT,
      negativePrompt: 'blurry',
      source: 'Regex',
      remixOfId: 11,
      inputImages: ['img-a'],
      inputVideo: 'vid-a',
    });
  });

  it('non-green hard external: reported with source External', async () => {
    externalFlags('violence');
    await expect(auditPromptServer({ ...base, isGreen: false })).rejects.toThrow(
      /^Your prompt was flagged: violence$/
    );
    expect(sysRedis.lPush).toHaveBeenCalledTimes(1);
    expect(track.prohibitedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'External' })
    );
  });

  it('green hard block: redirect message, and NOTHING recorded', async () => {
    flagWith(HARD);
    await expect(auditPromptServer({ ...base, isGreen: true })).rejects.toThrow(/civitai\.red/);
    expect(sysRedis.lPush).not.toHaveBeenCalled();
    expect(track.prohibitedRequest).not.toHaveBeenCalled();
  });

  it('soft block: reported once (count 0, so never toward a mute), no counter write', async () => {
    flagWith(SOFT);
    await expect(auditPromptServer({ ...base, isGreen: true })).rejects.toThrow(
      /^Your prompt was flagged: daughter$/
    );
    expect(track.prohibitedRequest).toHaveBeenCalledTimes(1);
    expect(track.prohibitedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'Regex' })
    );
    expect(sysRedis.lPush).not.toHaveBeenCalled();
    expect(mockApplyPendingReviewMute).not.toHaveBeenCalled();
  });

  it('an external-moderation failure is logged by the wrapper and still fails open', async () => {
    mockModeratePrompt.mockRejectedValueOnce(new Error('classifier down'));
    await expect(auditPromptServer({ ...base, isGreen: false })).resolves.toBeUndefined();
    expect(logToAxiom).toHaveBeenCalledTimes(1);
    expect(logToAxiom).toHaveBeenCalledWith({
      name: 'external-moderation-error',
      type: 'error',
      message: 'classifier down',
    });
  });

  it('clean text: no side effects at all', async () => {
    await expect(auditPromptServer({ ...base, isGreen: false })).resolves.toBeUndefined();
    expectNoSideEffects();
    expect(track.prohibitedRequest).not.toHaveBeenCalled();
  });
});
