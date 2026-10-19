import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserRestrictionService from '~/server/services/user-restriction.service';

/** A stored blocked prompt carries the evidence for why it was blocked. */

vi.mock('~/server/integrations/moderation', () => ({
  extModeration: { moderatePrompt: vi.fn(async () => ({ flagged: false, categories: [] })) },
}));
vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: vi.fn(async (text?: string) => text),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ updateUserById: vi.fn() }));
vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/user-restriction.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserRestrictionService>()),
  applyPendingReviewMute: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/prompt-origin', () => ({
  attachPromptOrigin: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn(),
  bustFetchThroughCache: vi.fn(),
}));
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mockSysRedis = redisMock.sysRedis;

// A hard minor-rule block whose NSFW gate word is `nude`.
const HARD_PROMPT = 'nude, young stepson';

beforeEach(() => {
  vi.clearAllMocks();
  mockSysRedis.exists.mockResolvedValue(1);
  mockSysRedis.lLen.mockResolvedValue(1);
});

describe('a live hard block', () => {
  it('stores the full match evidence on the entry', async () => {
    await expect(
      auditPromptServer({ prompt: `9 year old, ${HARD_PROMPT}`, userId: 5, isGreen: false })
    ).rejects.toBeDefined();

    const stored = JSON.parse(mockSysRedis.lPush.mock.calls[0][1] as string);
    expect(stored).toMatchObject({
      category: 'minor_age',
      matchedField: 'prompt',
    });
    expect(stored.matchedRegex).toEqual(expect.any(String));
    expect(stored.matches.map((m: { category: string }) => m.category)).toEqual([
      'minor_age',
      'inappropriate_minor',
      'inappropriate_minor',
    ]);
    expect(stored.matches[1].gateWord).toBe('nude');
  });

  it('records which field carried the match', async () => {
    await expect(
      auditPromptServer({
        prompt: 'nude woman',
        negativePrompt: 'mature body',
        userId: 5,
        isGreen: false,
      })
    ).rejects.toBeDefined();

    const stored = JSON.parse(mockSysRedis.lPush.mock.calls[0][1] as string);
    expect(stored).toMatchObject({
      category: 'inappropriate_minor',
      matchedField: 'negativePrompt',
    });
  });
});
