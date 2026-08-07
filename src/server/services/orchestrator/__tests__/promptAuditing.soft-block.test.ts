import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuditModule from '~/utils/metadata/audit';

/**
 * The generation gate lets a user proceed past the over-eager regex categories
 * ("I know what I'm doing") but must keep hard-blocking genuinely disallowed
 * content. These lock the boundary and the accounting that goes with it.
 */

const { mockAuditPromptEnriched, mockModeratePrompt, mockProhibited, mockSysRedis } = vi.hoisted(
  () => ({
    mockAuditPromptEnriched: vi.fn(),
    mockModeratePrompt: vi.fn(async () => ({ flagged: false, categories: [] as string[] })),
    mockProhibited: vi.fn(),
    mockSysRedis: {
      exists: vi.fn(async () => 1),
      lPush: vi.fn(async () => 1),
      lRange: vi.fn(async () => [] as string[]),
      lRem: vi.fn(async () => 1),
      lLen: vi.fn(async () => 1),
      del: vi.fn(),
      expire: vi.fn(),
      rPush: vi.fn(),
    },
  })
);

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
vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: {},
    sysRedis: mockSysRedis,
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
vi.mock('~/server/auth/session-invalidation', () => ({ refreshSession: vi.fn() }));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn(),
  bustFetchThroughCache: vi.fn(),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));

import {
  SOFT_BLOCK_ERROR_PREFIX,
  type PromptTrigger,
  type PromptTriggerCategory,
} from '~/utils/metadata/audit';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';

const trigger = (category: PromptTriggerCategory, message = 'x'): PromptTrigger => ({
  category,
  message,
  matchedWord: message,
});

const options = {
  prompt: 'a prompt',
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

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditPromptEnriched.mockReturnValue({ blockedFor: [], triggers: [], success: true });
});

describe('auditPromptServer — proceeding past a soft block', () => {
  it('an acknowledged soft block proceeds', async () => {
    flagWith(trigger('nsfw_blocklist'));
    await expect(
      auditPromptServer({ ...options, acknowledgedSoftBlock: true })
    ).resolves.toBeUndefined();
  });

  it('an acknowledged soft block is still reported for moderator review', async () => {
    flagWith(trigger('nsfw_blocklist'));
    await auditPromptServer({ ...options, acknowledgedSoftBlock: true });
    expect(mockProhibited).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'Regex (acknowledged)' })
    );
  });

  it('an acknowledged soft block does NOT count toward the auto-mute threshold', async () => {
    flagWith(trigger('nsfw_blocklist'));
    await auditPromptServer({ ...options, acknowledgedSoftBlock: true });
    // addBlockedPrompt is the only writer of the violation counter.
    expect(mockSysRedis.lPush).not.toHaveBeenCalled();
  });

  it('an UNacknowledged soft block still blocks, and marks itself overridable', async () => {
    flagWith(trigger('nsfw_blocklist'));
    await expect(auditPromptServer(options)).rejects.toThrow(SOFT_BLOCK_ERROR_PREFIX);
  });

  it('an acknowledgement does NOT unlock a hard block', async () => {
    flagWith(trigger('poi', 'Prompt cannot include celebrity names'));
    await expect(auditPromptServer({ ...options, acknowledgedSoftBlock: true })).rejects.toThrow(
      /celebrity/
    );
    // Hard blocks keep counting toward the mute.
    expect(mockSysRedis.lPush).toHaveBeenCalled();
  });

  it('an acknowledgement does NOT unlock a mixed soft+hard block', async () => {
    flagWith(trigger('profanity'), trigger('inappropriate_minor'));
    await expect(
      auditPromptServer({ ...options, acknowledgedSoftBlock: true })
    ).rejects.toBeDefined();
  });

  it('a hard block is not marked overridable', async () => {
    flagWith(trigger('poi'));
    await expect(auditPromptServer(options)).rejects.not.toThrow(SOFT_BLOCK_ERROR_PREFIX);
  });

  // civitai.green's whole purpose is the SFW guarantee, so there is no
  // click-through there even for a category that is soft on .com/.red.
  it('civitai.green has no override path', async () => {
    flagWith(trigger('profanity'));
    await expect(
      auditPromptServer({ ...options, isGreen: true, acknowledgedSoftBlock: true })
    ).rejects.toThrow(/SFW/);
  });
});
