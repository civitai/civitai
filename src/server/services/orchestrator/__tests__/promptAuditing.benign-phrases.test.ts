import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The moderator-managed benign-phrase lists (PromptBenignPhrase /
 * NegativeBenignPhrase) must apply to the GENERATION gate, not just the
 * post-generation scan audit. Regression guard for the gap where 8d23361cc9
 * moved benign handling out of audit.ts into the Blocklist store but only wired
 * it into the two scan paths, leaving `auditPromptServer` auditing raw text.
 *
 * Also locks in that only the AUDITED copy is cleaned — the original prompt is
 * what still reaches ClickHouse / the blocked-prompt entry.
 */

const { mockStripBenignPhrases, mockAuditPromptEnriched, mockModeratePrompt, mockProhibited } =
  vi.hoisted(() => ({
    mockStripBenignPhrases: vi.fn(),
    mockAuditPromptEnriched: vi.fn(),
    mockModeratePrompt: vi.fn(async () => ({ flagged: false, categories: [] as string[] })),
    mockProhibited: vi.fn(),
  }));

vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: mockStripBenignPhrases,
}));
vi.mock('~/utils/metadata/audit', () => ({ auditPromptEnriched: mockAuditPromptEnriched }));
vi.mock('~/server/integrations/moderation', () => ({
  extModeration: { moderatePrompt: mockModeratePrompt },
}));

vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: {},
    sysRedis: {
      exists: vi.fn(async () => 1),
      lPush: vi.fn(async () => 1),
      lRange: vi.fn(async () => [] as string[]),
      lRem: vi.fn(async () => 1),
      lLen: vi.fn(async () => 1),
      del: vi.fn(),
      expire: vi.fn(),
      rPush: vi.fn(),
    },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    withSysReadDeadline: vi.fn((p: Promise<unknown>) => p),
  };
});
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ updateUserById: vi.fn() }));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn(),
  bustFetchThroughCache: vi.fn(),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));

import { BlocklistType } from '~/server/common/enums';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';

const PROMPT = 'raven from teen titans';
const NEGATIVE = 'mature content, blurry';

const options = {
  prompt: PROMPT,
  negativePrompt: NEGATIVE,
  userId: 5,
  isGreen: false,
  track: { prohibitedRequest: mockProhibited },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditPromptEnriched.mockReturnValue({ triggers: [], success: true });
  mockStripBenignPhrases.mockImplementation(async (text: string | undefined) =>
    text?.replace(/teen titans|mature content/gi, ' ')
  );
});

describe('auditPromptServer — benign-phrase stripping', () => {
  it('audits the stripped prompt/negativePrompt, using the matching blocklist type for each', async () => {
    await expect(auditPromptServer(options)).resolves.toBeUndefined();

    expect(mockStripBenignPhrases).toHaveBeenCalledWith(PROMPT, BlocklistType.PromptBenignPhrase);
    expect(mockStripBenignPhrases).toHaveBeenCalledWith(
      NEGATIVE,
      BlocklistType.NegativeBenignPhrase
    );

    const [auditedPrompt, auditedNegative] = mockAuditPromptEnriched.mock.calls[0];
    expect(auditedPrompt).not.toContain('teen titans');
    expect(auditedNegative).not.toContain('mature content');
    // External moderation sees the same cleaned text as the regex audit.
    expect(mockModeratePrompt).toHaveBeenCalledWith(auditedPrompt);
  });

  it('a prompt that only trips on a benign phrase is no longer blocked', async () => {
    mockAuditPromptEnriched.mockImplementation((prompt: string) =>
      /teen titans/i.test(prompt)
        ? { triggers: [{ message: 'minor', category: 'inappropriate_minor' }], success: false }
        : { triggers: [], success: true }
    );

    await expect(auditPromptServer(options)).resolves.toBeUndefined();
  });

  it('records the ORIGINAL prompt when the stripped copy still trips the audit', async () => {
    mockAuditPromptEnriched.mockReturnValue({
      triggers: [{ message: 'blocked term', category: 'regex', matchedWord: 'x' }],
      success: false,
    });

    await expect(auditPromptServer(options)).rejects.toThrow();

    expect(mockProhibited).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: PROMPT, negativePrompt: NEGATIVE })
    );
  });

  it('fails CLOSED when the blocklist read fails — the request aborts, the audit is never skipped', async () => {
    mockStripBenignPhrases.mockRejectedValue(new Error('redis is down'));

    await expect(auditPromptServer(options)).rejects.toThrow();
    expect(mockAuditPromptEnriched).not.toHaveBeenCalled();
  });
});
