import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuditModule from '~/utils/metadata/audit';

/**
 * The generation gate lets a user proceed past the over-eager regex categories
 * ("I know what I'm doing") but must keep hard-blocking genuinely disallowed
 * content. These lock the boundary and the accounting that goes with it.
 */

const {
  mockAuditPromptEnriched,
  mockModeratePrompt,
  mockProhibited,
  mockSysRedis,
  mockLogToAxiom,
  mockUpdateUserById,
} = vi.hoisted(() => ({
  mockLogToAxiom: vi.fn(async () => undefined),
  mockUpdateUserById: vi.fn(async () => undefined),
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
vi.mock('~/server/services/user.service', () => ({ updateUserById: mockUpdateUserById }));
vi.mock('~/server/auth/session-invalidation', () => ({ refreshSession: vi.fn() }));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn(),
  bustFetchThroughCache: vi.fn(),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));

import type { PromptTrigger, PromptTriggerCategory } from '~/utils/metadata/audit';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';

// `daughter` is a real soft-tier blocklist entry; `rape` is a real hard-tier one.
// nsfw_blocklist severity is per matched word, so these are not interchangeable.
const trigger = (category: PromptTriggerCategory, message = 'daughter'): PromptTrigger => ({
  category,
  message,
  matchedWord: message,
});

/** The soft flag reaches the client as `error.data.softBlock`, via trpc.ts's errorFormatter. */
const softFlagOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (e) {
    return (e as { cause?: { softBlock?: boolean } }).cause?.softBlock;
  }
};

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
    // 'Regex' — NOT a decorated variant. The ClickHouse column is
    // Enum8('Regex','External'); anything else is rejected and swallowed, which
    // is how an earlier revision recorded nothing at all.
    expect(mockProhibited).toHaveBeenCalledWith(expect.objectContaining({ source: 'Regex' }));
  });

  it('an acknowledged soft block leaves an override trail', async () => {
    flagWith(trigger('nsfw_blocklist'));
    await auditPromptServer({ ...options, acknowledgedSoftBlock: true });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'prompt-soft-block-override' })
    );
  });

  it('an acknowledged soft block does NOT count toward the auto-mute threshold', async () => {
    flagWith(trigger('nsfw_blocklist'));
    await auditPromptServer({ ...options, acknowledgedSoftBlock: true });
    // addBlockedPrompt is the only writer of the violation counter.
    expect(mockSysRedis.lPush).not.toHaveBeenCalled();
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('an UNacknowledged soft block still blocks, and marks itself overridable', async () => {
    flagWith(trigger('nsfw_blocklist'));
    expect(await softFlagOf(auditPromptServer(options))).toBe(true);
  });

  it('an UNacknowledged soft block does NOT count toward the auto-mute either', async () => {
    flagWith(trigger('nsfw_blocklist'));
    await expect(auditPromptServer(options)).rejects.toBeDefined();
    // Counting the warning would auto-mute the very users this feature helps,
    // while the "Generate Anyway" button is rendered under the mute notice.
    expect(mockSysRedis.lPush).not.toHaveBeenCalled();
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('a soft block carries no escalating account-review threat', async () => {
    flagWith(trigger('nsfw_blocklist'));
    await expect(auditPromptServer(options)).rejects.not.toThrow(/sent for review|been muted/);
  });

  it('a soft block is reported exactly once', async () => {
    flagWith(trigger('nsfw_blocklist'));
    await expect(auditPromptServer(options)).rejects.toBeDefined();
    expect(mockProhibited).toHaveBeenCalledTimes(1);
  });

  it('the soft marker never touches the user-facing message', async () => {
    flagWith(trigger('nsfw_blocklist'));
    // EnhanceTab and App Blocks match this message with `startsWith`.
    await expect(auditPromptServer(options)).rejects.toThrow(/^Your prompt was flagged/);
  });

  // A soft regex block must not short-circuit the hosted classifier: appending an
  // overridable word ("… pee") would otherwise buy a click-through past it, and
  // `acknowledgedSoftBlock` is client-supplied.
  it('an acknowledged soft block still runs external moderation', async () => {
    flagWith(trigger('nsfw_blocklist'));
    await auditPromptServer({ ...options, acknowledgedSoftBlock: true });
    expect(mockModeratePrompt).toHaveBeenCalled();
  });

  it('external moderation overrides an acknowledged soft block', async () => {
    flagWith(trigger('nsfw_blocklist'));
    mockModeratePrompt.mockResolvedValueOnce({ flagged: true, categories: ['sexual/minors'] });
    await expect(
      auditPromptServer({ ...options, acknowledgedSoftBlock: true })
    ).rejects.toBeDefined();
    // External is hard, so this one counts toward the mute.
    expect(mockSysRedis.lPush).toHaveBeenCalled();
  });

  it('an acknowledgement does NOT unlock a hard block', async () => {
    flagWith(trigger('poi', 'Prompt cannot include celebrity names'));
    await expect(auditPromptServer({ ...options, acknowledgedSoftBlock: true })).rejects.toThrow(
      /celebrity/
    );
    // Hard blocks keep counting toward the mute.
    expect(mockSysRedis.lPush).toHaveBeenCalled();
  });

  it('an acknowledgement does NOT unlock a hard-tier blocklist word', async () => {
    flagWith(trigger('nsfw_blocklist', 'rape'));
    await expect(
      auditPromptServer({ ...options, acknowledgedSoftBlock: true })
    ).rejects.toBeDefined();
    expect(mockSysRedis.lPush).toHaveBeenCalled();
  });

  it('an acknowledgement does NOT unlock a mixed soft+hard block', async () => {
    flagWith(trigger('nsfw_blocklist'), trigger('inappropriate_minor'));
    await expect(
      auditPromptServer({ ...options, acknowledgedSoftBlock: true })
    ).rejects.toBeDefined();
  });

  it('a hard block is not marked overridable', async () => {
    flagWith(trigger('poi'));
    expect(await softFlagOf(auditPromptServer(options))).toBeUndefined();
  });

  // The override applies on every domain, green included. `profanity` only ever
  // fires on green (checkProfanity = isGreen), so this is the ONLY path that
  // makes that category reachable at all.
  it('a green soft block keeps the SFW redirect', async () => {
    flagWith(trigger('profanity', 'damn'));
    await expect(auditPromptServer({ ...options, isGreen: true })).rejects.toThrow(/civitai\.red/);
  });

  it('civitai.green can override a profanity block', async () => {
    flagWith(trigger('profanity', 'damn'));
    await expect(
      auditPromptServer({ ...options, isGreen: true, acknowledgedSoftBlock: true })
    ).resolves.toBeUndefined();
  });

  it('civitai.green still hard-blocks a minor category', async () => {
    flagWith(trigger('inappropriate_minor'));
    await expect(
      auditPromptServer({ ...options, isGreen: true, acknowledgedSoftBlock: true })
    ).rejects.toThrow(/SFW/);
  });
});
