import { describe, it, expect, vi, beforeEach } from 'vitest';

// New Order must never enqueue or show a player an image whose stored needsReview is a held
// key, judged on the row as read at that moment (not on what the caller saw earlier). Each case
// puts a clean image beside the held one, so an empty result cannot pass.
//
// Real service; dbRead, redis, clickhouse and the pool counters are faked. The dbRead fake
// honours `where.id` and `select` only, so the guard under test is the service's own row check
// on a column it actually selected, not a query filter the fake would ignore.

const { counterStub, poolStub, mockQuery } = vi.hoisted(() => {
  const counter = () => ({
    increment: vi.fn(),
    decrement: vi.fn(),
    reset: vi.fn(),
    getCount: vi.fn().mockResolvedValue(0),
    getCountBatch: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
    exists: vi.fn(),
    key: 'stub',
  });
  return { counterStub: counter(), poolStub: counter(), mockQuery: vi.fn() };
});

vi.mock('~/server/games/new-order/utils', () => ({
  acolyteFailedJudgments: counterStub,
  allJudgmentsCounter: counterStub,
  blessedBuzzCounter: counterStub,
  correctJudgmentsCounter: counterStub,
  expCounter: counterStub,
  fervorCounter: counterStub,
  pendingBuzzCounter: counterStub,
  recentlyGrantedBuzzCounter: counterStub,
  sanityCheckFailuresCounter: counterStub,
  smitesCounter: counterStub,
  poolCounters: { Knight: { a: [poolStub] } },
  DEFAULT_POOL_QUOTAS: {},
  checkVotingRateLimit: vi.fn(),
  computePoolTargets: vi.fn(),
  getActiveSlot: vi.fn().mockResolvedValue('a'),
  clearImageRatings: vi.fn(),
  getImageRatingsCounter: vi.fn(),
  getVotingCooldownUntil: vi.fn().mockResolvedValue(null),
  getVotingRateLimitConfig: vi.fn().mockResolvedValue(null),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: mockQuery } }));
vi.mock('~/server/utils/errorHandling', () => ({
  handleLogError: vi.fn(),
  throwBadRequestError: vi.fn(),
  throwInternalServerError: vi.fn(),
  throwNotFoundError: vi.fn(),
  throwRateLimitError: vi.fn(),
}));
vi.mock('~/server/utils/otel-helpers', () => ({ withSpan: (_n: string, fn: any) => fn() }));
vi.mock('~/server/utils/game-helpers', () => ({ getLevelProgression: vi.fn() }));
vi.mock('~/server/utils/cache-helpers', () => ({ fetchThroughCache: vi.fn() }));
vi.mock('~/server/utils/distributed-lock', () => ({ withDistributedLock: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  handleBlockImages: vi.fn(),
  updateImageNsfwLevel: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/report.service', () => ({ createReport: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ awardTrophyCosmetic: vi.fn() }));
vi.mock('~/utils/signal-client', () => ({ signalClient: { topicSend: vi.fn() } }));

import {
  addImageToQueue,
  getImagesQueue,
  getPlayerHistory,
  getSanityCheckImage,
  RATED_SET_COMPLETE,
} from '~/server/services/games/new-order.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

const CLEAN = 1;
const HELD = 2;
// A second review key, so the guard is not tied to one value.
const HELD_OTHER = 3;
const SANITY_CLEAN = 10;
const SANITY_HELD = 11;

const rows: Record<number, { needsReview: string | null }> = {
  [CLEAN]: { needsReview: null },
  [HELD]: { needsReview: 'csam' },
  [HELD_OTHER]: { needsReview: 'minor' },
  [SANITY_CLEAN]: { needsReview: null },
  [SANITY_HELD]: { needsReview: 'csam' },
};
// Ids from 100 up are clean filler for the pool-offset case.
const lookup = (id: number) => rows[id] ?? (id >= 100 ? { needsReview: null } : undefined);
const row = (id: number, select: Record<string, boolean>) => {
  const full: Record<string, unknown> = {
    id,
    url: `https://example.test/${id}.jpg`,
    nsfwLevel: 1,
    metadata: {},
    ...lookup(id),
  };
  return Object.fromEntries(Object.keys(select).map((key) => [key, full[key]]));
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.image.findMany.mockImplementation(async (args: any) =>
    (args.where.id.in as number[]).filter((id) => lookup(id)).map((id) => row(id, args.select))
  );
  dbMock.dbRead.image.findUnique.mockImplementation(async (args: any) =>
    lookup(args.where.id) ? row(args.where.id, args.select) : null
  );
  dbMock.dbRead.newOrderPlayer.findUnique.mockResolvedValue({
    user: {},
    rankType: NewOrderRankType.Knight,
    startAt: new Date('2026-01-01T00:00:00Z'),
  });
  redisMock.redis.sIsMember.mockImplementation(
    async (_key: string, id: string) => id === RATED_SET_COMPLETE
  ); // set is built
  redisMock.redis.smIsMember.mockImplementation(async (_key: string, ids: string[]) =>
    ids.map(() => false)
  );
  redisMock.sysRedis.sMembers.mockResolvedValue([]);
  poolStub.getAll.mockResolvedValue([]);
  poolStub.reset.mockResolvedValue(undefined);
});

describe('New Order held-image guard', () => {
  it('(a) addImageToQueue enqueues the clean image and never the held one', async () => {
    await addImageToQueue({
      imageIds: [CLEAN, HELD, HELD_OTHER],
      rankType: NewOrderRankType.Knight,
      priority: 1,
    });

    const enqueued = poolStub.getCount.mock.calls.map(([id]) => id);
    expect(enqueued).toEqual([CLEAN]);
  });

  it('(a2) addImageToQueue reports nothing added when every image is held', async () => {
    const added = await addImageToQueue({
      imageIds: [HELD],
      rankType: NewOrderRankType.Knight,
      priority: 1,
    });

    expect(added).toEqual({ added: false, heldIds: [HELD] });
    expect(poolStub.getCount).not.toHaveBeenCalled();
  });

  it('(b) getImagesQueue serves the clean image, not the held one, and drops the held one from its pool', async () => {
    poolStub.getAll.mockResolvedValueOnce([
      { value: String(CLEAN), score: 0 },
      { value: String(HELD), score: 0 },
      { value: String(HELD_OTHER), score: 0 },
    ]);

    const served = await getImagesQueue({ playerId: 5, imageCount: 10 });

    expect(served.map((i) => i.id)).toEqual([CLEAN]);
    served.forEach((image) => expect(image).not.toHaveProperty('needsReview'));
    expect(poolStub.reset).toHaveBeenCalledTimes(1);
    expect(poolStub.reset).toHaveBeenCalledWith({ id: [HELD, HELD_OTHER] });
  });

  it('(b2) removing a held image does not skip the pool members after it', async () => {
    // 1 held + 100 clean; imageCount 50 reads windows of 100, so the 101st member is only
    // reached if the next window accounts for the member that was removed.
    let members = [HELD, ...Array.from({ length: 100 }, (_, i) => 100 + i)];
    const read = new Set<number>();
    poolStub.getAll.mockImplementation(
      async ({ limit, offset }: { limit: number; offset: number }) => {
        const window = members.slice(offset, offset + limit);
        window.forEach((id) => read.add(id));
        return window.map((id) => ({ value: String(id), score: 0 }));
      }
    );
    poolStub.reset.mockImplementation(async ({ id }: { id: number[] }) => {
      members = members.filter((m) => !id.includes(m));
    });

    await getImagesQueue({ playerId: 5, imageCount: 50 });

    expect(members).not.toContain(HELD);
    expect(members.filter((m) => !read.has(m))).toEqual([]);
  });

  it('(b3) a failed pool removal still serves the queue without the held image', async () => {
    poolStub.getAll.mockResolvedValueOnce([
      { value: String(CLEAN), score: 0 },
      { value: String(HELD), score: 0 },
    ]);
    poolStub.reset.mockRejectedValue(new Error('redis down'));

    const served = await getImagesQueue({ playerId: 5, imageCount: 10 });

    expect(served.map((i) => i.id)).toEqual([CLEAN]);
  });

  it('(c) getSanityCheckImage returns the clean sanity image and nothing for a held one', async () => {
    redisMock.sysRedis.sMembers.mockResolvedValue([`${SANITY_CLEAN}:4`]);
    expect(await getSanityCheckImage()).toMatchObject({ imageId: SANITY_CLEAN });

    redisMock.sysRedis.sMembers.mockResolvedValue([`${SANITY_HELD}:4`]);
    expect(await getSanityCheckImage()).toBeNull();
  });

  it('(d) the sanity checks mixed into a Knight queue skip a held image', async () => {
    // A single-member sanity pool makes the pick deterministic.
    const serveWithSanityPool = async (sanityId: number) => {
      poolStub.getAll.mockResolvedValueOnce([{ value: String(CLEAN), score: 0 }]);
      redisMock.sysRedis.sMembers.mockResolvedValue([`${sanityId}:4`]);
      return (await getImagesQueue({ playerId: 5, imageCount: 10 })).map((i) => i.id).sort();
    };

    expect(await serveWithSanityPool(SANITY_CLEAN)).toEqual([CLEAN, SANITY_CLEAN]);
    expect(await serveWithSanityPool(SANITY_HELD)).toEqual([CLEAN]);
  });

  it('(e) getPlayerHistory lists the clean image and omits the held one', async () => {
    const judgment = (imageId: number) => ({
      imageId,
      rating: 1,
      status: 'Correct',
      grantedExp: 0,
      multiplier: 1,
      originalLevel: null,
      lastCreatedAt: new Date('2026-02-01T00:00:00Z'),
    });
    mockQuery.mockResolvedValue([judgment(CLEAN), judgment(HELD), judgment(HELD_OTHER)]);

    const { items } = await getPlayerHistory({ playerId: 5, limit: 10 });

    expect(items.map((i) => i.image.id)).toEqual([CLEAN]);
    expect(items[0].image).not.toHaveProperty('needsReview');
  });
});
