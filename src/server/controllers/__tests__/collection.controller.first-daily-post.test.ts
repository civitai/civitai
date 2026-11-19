import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as CollectionService from '~/server/services/collection.service';
import type * as PostService from '~/server/services/post.service';

const isAccountMuted = vi.hoisted(() => vi.fn());

// Runs the REAL firstDailyPostReward; only its edges are faked: the Buzz ledger, the ClickHouse
// audit insert and Redis (a transcription of the on-demand Lua, as in
// base.reward.duplicate-award.test.ts).

const h = vi.hoisted(() => ({
  inserts: [] as { status: string; forId: number }[],
  createBuzzTransactionMany: vi.fn(),
  getCollectionById: vi.fn(),
  createPost: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    insert: async ({ table, values }: { table: string; values: never[] }) => {
      if (table === 'buzzEvents') h.inserts.push(...JSON.parse(JSON.stringify(values)));
    },
    $query: vi.fn(async () => []),
    query: vi.fn(async () => ({ json: async () => [] })),
  },
}));
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  rewardFailedCounter: { inc: vi.fn() },
  rewardGivenCounter: { inc: vi.fn() },
  clickhouseFailSoftCounter: { inc: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createBuzzTransactionMany: (...args: unknown[]) => h.createBuzzTransactionMany(...args),
  getTransactionByExternalId: vi.fn(async () => null),
  getMultipliersForUser: vi.fn(async () => ({ rewardsMultiplier: 1 })),
}));
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getCollectionById: h.getCollectionById,
  getUserCollectionPermissionsById: vi.fn(async () => ({ write: true })),
  bulkSaveItems: vi.fn(async () => undefined),
  validateContestCollectionEntry: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  createPost: h.createPost,
  addPostImage: vi.fn(async ({ postId }: { postId: number }) => ({ id: postId * 10 })),
  deletePost: vi.fn(),
}));

vi.mock('~/server/services/account-standing.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isAccountMuted: (...args: unknown[]) => isAccountMuted(...args),
}));

import { addSimpleImagePostHandler } from '../collection.controller';
import { OnboardingSteps } from '~/server/common/enums';
import { firstDailyPostReward } from '~/server/rewards';
import { ON_DEMAND_REWARD_SCRIPT } from '~/server/rewards/base.reward';
import { invalidateRewardConfigCache } from '~/server/rewards/reward-config';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const USER_ID = 7;
const DAY = '2026-11-09T12:00:00Z';

let hashes: Record<string, string> = {};
const evalScript = (script: string, { arguments: args }: { arguments: string[] }) => {
  if (script !== ON_DEMAND_REWARD_SCRIPT) throw new Error('redis fake: unknown script');
  const [field, cacheKey, award, cap] = args;
  const cache = JSON.parse(hashes[field] ?? '{}') as Record<string, string>;
  if (cache[cacheKey] !== undefined) return -1;
  // As the script does, an entry without a paid amount counts as a full award.
  const awarded = Object.values(cache).reduce((sum, e) => {
    const paid = /^a:(\d+)$/.exec(e);
    return sum + (paid ? Number(paid[1]) : Number(award));
  }, 0);
  const toAward = Math.min(Number(award), Math.max(Number(cap) - awarded, 0));
  cache[cacheKey] = `a:${toAward}`;
  hashes[field] = JSON.stringify(cache);
  return toAward;
};

let nextPostId = 500;
const ctx = {
  user: { id: USER_ID, isModerator: false, onboarding: OnboardingSteps.Buzz },
  features: { userChallenges: false },
  ip: '203.0.113.9',
} as never;
const enter = () =>
  addSimpleImagePostHandler({
    input: { collectionId: 42, images: [{ url: 'k', type: 'image' }] as never },
    ctx,
  });

const paidPostIds = () =>
  h.createBuzzTransactionMany.mock.calls.flatMap(([txs]) =>
    (txs as { externalTransactionId: string }[]).map((tx) => tx.externalTransactionId)
  );

beforeEach(() => {
  vi.clearAllMocks();
  isAccountMuted.mockResolvedValue(false);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(DAY));
  invalidateRewardConfigCache();
  hashes = {};
  h.inserts.length = 0;
  nextPostId = 500;
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  redisMock.redis.eval.mockImplementation(evalScript as never);
  h.createBuzzTransactionMany.mockResolvedValue({ transactions: ['tx'], conflicts: [] });
  h.getCollectionById.mockResolvedValue({ id: 42, name: 'C', read: 'Public', mode: 'Contest' });
  h.createPost.mockImplementation(async ({ publishedAt }: { publishedAt?: Date }) => ({
    id: nextPostId++,
    publishedAt: publishedAt ?? null,
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('first post of the day reward on Daily Challenge Submit entries', () => {
  it('pays the first entry of the day', async () => {
    await enter();

    expect(h.createBuzzTransactionMany).toHaveBeenCalledTimes(1);
    expect(h.inserts).toMatchObject([{ forId: 500, status: 'awarded' }]);
  });

  it('pays once for several entries the same day', async () => {
    await enter();
    await enter();
    await enter();

    expect(paidPostIds()).toHaveLength(1);
    expect(h.inserts.map((e) => [e.forId, e.status])).toEqual([
      [500, 'awarded'],
      [501, 'capped'],
      [502, 'capped'],
    ]);
  });

  it('does not pay again when the entry post is later published through the editor', async () => {
    const { post } = await enter();
    expect(h.inserts).toMatchObject([{ forId: post.id, status: 'awarded' }]);

    // post.update's call shape on publish.
    await firstDailyPostReward.apply({ postId: post.id, posterId: USER_ID }, { ip: '203.0.113.9' });

    expect(h.createBuzzTransactionMany).toHaveBeenCalledTimes(1);
    expect(h.inserts).toHaveLength(1);
  });
});
