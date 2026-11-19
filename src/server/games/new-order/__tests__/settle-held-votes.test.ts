import { describe, it, expect, vi, beforeEach } from 'vitest';

// When New Order drops an image held for review from a queue, nothing will settle the Knight votes
// still Pending on it, so they are voided (Inconclusive) the way the daily slot purge does. The void
// is a NULL rating in `knights_rating_updates_buffer`; these tests read that insert.
//
// Real service; dbRead, redis, clickhouse, the pool counters and the Axiom logger are faked. The
// dbRead fake honours `where.id` and `select`.

const { counter, knightPool, inquisitorPool, ratingsCounter, mockCh, mockClearRatings } =
  vi.hoisted(() => {
    const counter = () => ({
      increment: vi.fn().mockResolvedValue(0),
      decrement: vi.fn().mockResolvedValue(0),
      reset: vi.fn().mockResolvedValue(undefined),
      getCount: vi.fn().mockResolvedValue(0),
      getCountBatch: vi.fn(),
      getAll: vi.fn().mockResolvedValue([]),
      exists: vi.fn().mockResolvedValue(false),
      key: 'stub',
    });
    return {
      counter: counter(),
      knightPool: counter(),
      inquisitorPool: counter(),
      ratingsCounter: counter(),
      mockCh: { $query: vi.fn(), $exec: vi.fn(), insert: vi.fn() },
      mockClearRatings: vi.fn(),
    };
  });

vi.mock('~/server/games/new-order/utils', () => ({
  // The branch reads this to map a Paladin onto the Templar pools; the real mapping is one line.
  legacyRank: (rank: string) => (rank === 'Paladin' ? 'Templar' : rank),
  acolyteFailedJudgments: counter,
  allJudgmentsCounter: counter,
  blessedBuzzCounter: counter,
  correctJudgmentsCounter: counter,
  expCounter: counter,
  fervorCounter: counter,
  pendingBuzzCounter: counter,
  recentlyGrantedBuzzCounter: counter,
  sanityCheckFailuresCounter: counter,
  smitesCounter: counter,
  poolCounters: {
    Knight: { a: [knightPool], b: [] },
    Inquisitor: { a: [inquisitorPool], b: [] },
    Templar: { a: [], b: [] },
  },
  DEFAULT_POOL_QUOTAS: {},
  checkVotingRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  computePoolTargets: vi.fn(),
  getActiveSlot: vi.fn().mockResolvedValue('a'),
  clearImageRatings: mockClearRatings,
  getImageRatingsCounter: vi.fn(() => ratingsCounter),
  getVotingCooldownUntil: vi.fn().mockResolvedValue(null),
  getVotingRateLimitConfig: vi.fn().mockResolvedValue(null),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: mockCh }));
vi.mock('~/server/utils/errorHandling', () => ({
  handleLogError: vi.fn(),
  throwBadRequestError: vi.fn(),
  throwInternalServerError: vi.fn(),
  throwNotFoundError: vi.fn(),
  throwRateLimitError: vi.fn(),
}));
vi.mock('~/server/utils/otel-helpers', () => ({ withSpan: (_n: string, fn: any) => fn() }));
vi.mock('~/server/utils/game-helpers', () => ({
  getLevelProgression: vi.fn(() => ({ level: 1 })),
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn().mockResolvedValue([{ type: 'Knight', name: 'Knight', minExp: 0 }]),
}));
vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: (_opts: unknown, fn: () => unknown) => fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  handleBlockImages: vi.fn(),
  updateImageNsfwLevel: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/report.service', () => ({ createReport: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ awardTrophyCosmetic: vi.fn() }));
vi.mock('~/utils/signal-client', () => ({
  signalClient: {
    topicSend: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  addImageRating,
  getImagesQueue,
  leaveQueuesAfterModeratorRating,
  RATED_SET_COMPLETE,
} from '~/server/services/games/new-order.service';
import { handleLogError } from '~/server/utils/errorHandling';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { NsfwLevel, NewOrderImageRatingStatus } from '~/server/common/enums';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

const CLEAN = 1;
const HELD = 2;
const PLAYER = 5;

const rows: Record<number, { needsReview: string | null }> = {
  [CLEAN]: { needsReview: null },
  [HELD]: { needsReview: 'appeal' },
};
const row = (id: number, select: Record<string, boolean>) => {
  const full: Record<string, unknown> = {
    id,
    url: `https://example.test/${id}.jpg`,
    nsfwLevel: NsfwLevel.XXX,
    metadata: {},
    ...rows[id],
  };
  return Object.fromEntries(Object.keys(select).map((key) => [key, full[key]]));
};

const voidedIds = () =>
  mockCh.insert.mock.calls
    .filter(([args]) => args.table === 'knights_rating_updates_buffer')
    .flatMap(([args]) => args.values as { imageId: number; rating: null }[])
    .map((v) => {
      expect(v.rating).toBeNull();
      return v.imageId;
    });
const loggedEvents = () => loggingMock.logToAxiom.mock.calls.map(([entry]) => entry.name);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.image.findMany.mockImplementation(async (args: any) =>
    (args.where.id.in as number[]).filter((id) => rows[id]).map((id) => row(id, args.select))
  );
  dbMock.dbRead.image.findUnique.mockImplementation(async (args: any) =>
    rows[args.where.id] ? row(args.where.id, args.select) : null
  );
  dbMock.dbRead.newOrderPlayer.findUnique.mockResolvedValue({
    user: {},
    rankType: NewOrderRankType.Knight,
    rank: { name: 'Knight' },
    startAt: new Date('2026-01-01T00:00:00Z'),
  });
  redisMock.redis.sIsMember.mockImplementation(
    async (_key: string, id: string) => id === RATED_SET_COMPLETE
  ); // set is built
  redisMock.redis.smIsMember.mockImplementation(async (_key: string, ids: string[]) =>
    ids.map(() => false)
  );
  redisMock.sysRedis.sMembers.mockResolvedValue([]);
  redisMock.sysRedis.sIsMember.mockResolvedValue(false);
  // processFinalRatings is throttled; a recent last run makes it return before touching Redis.
  redisMock.sysRedis.incr.mockResolvedValue(1);
  redisMock.sysRedis.get.mockResolvedValue(String(Date.now()));
  mockCh.insert.mockResolvedValue(undefined);
  const chain: any = { sAdd: () => chain, expire: () => chain, exec: async () => [] };
  redisMock.redis.multi.mockReturnValue(chain);
  knightPool.getAll.mockResolvedValue([]);
  knightPool.reset.mockResolvedValue(undefined);
});

// The vote that completes a Knight consensus five levels below the image's level, which escalates
// the image to the Inquisitor queue.
async function castEscalatingVote(imageId: number) {
  knightPool.exists.mockImplementation(async (id: number) => id === imageId);
  knightPool.getCount.mockResolvedValue(4);
  knightPool.increment.mockResolvedValue(5);
  ratingsCounter.getAll.mockResolvedValue([{ value: `Knight-${NsfwLevel.PG}`, score: 10_000 }]);
  const tracker = { newOrderImageRating: vi.fn().mockResolvedValue(undefined) };
  await addImageRating({
    playerId: PLAYER,
    imageId,
    rating: NsfwLevel.PG,
    chTracker: tracker as any,
  });
  expect(tracker.newOrderImageRating).toHaveBeenCalledTimes(1);
  return tracker.newOrderImageRating.mock.calls[0][0].status as NewOrderImageRatingStatus;
}

describe('pending votes on images New Order drops for review', () => {
  it('(a) an escalation control: a clean image is escalated, logged, and its votes stay Pending', async () => {
    const status = await castEscalatingVote(CLEAN);

    expect(inquisitorPool.getCount).toHaveBeenCalledWith(CLEAN);
    expect(status).toBe(NewOrderImageRatingStatus.Pending);
    expect(voidedIds()).toEqual([]);
    expect(loggedEvents()).toContain('new-order-down-rating-escalated');
    expect(loggedEvents()).not.toContain('new-order-escalation-skipped');
  });

  it('(a) a held image is not escalated: its votes are voided, this one is Inconclusive, and the skip is logged', async () => {
    const status = await castEscalatingVote(HELD);

    expect(inquisitorPool.getCount).not.toHaveBeenCalled();
    expect(voidedIds()).toEqual([HELD]);
    expect(status).toBe(NewOrderImageRatingStatus.Inconclusive);
    expect(loggedEvents()).not.toContain('new-order-down-rating-escalated');
    const skipped = loggingMock.logToAxiom.mock.calls.find(
      ([e]) => e.name === 'new-order-escalation-skipped'
    )?.[0];
    expect(skipped?.details).toEqual({ imageId: HELD, userId: PLAYER });
  });

  it('(e) this vote is still written Inconclusive when the void fails', async () => {
    mockCh.insert.mockRejectedValue(new Error('clickhouse down'));

    const status = await castEscalatingVote(HELD);

    expect(status).toBe(NewOrderImageRatingStatus.Inconclusive);
  });

  it('(b) a held image removed from a pool during a queue read has its votes voided', async () => {
    knightPool.getAll.mockResolvedValueOnce([
      { value: String(CLEAN), score: 0 },
      { value: String(HELD), score: 0 },
    ]);

    await getImagesQueue({ playerId: PLAYER, imageCount: 10 });

    expect(voidedIds()).toEqual([HELD]);
    expect(mockClearRatings).toHaveBeenCalledWith([HELD]);
    // processFinalRatings ran (its first step counts the request).
    expect(redisMock.sysRedis.incr).toHaveBeenCalledTimes(1);
  });

  it('(b) a held image whose pool removal failed is left for the daily purge, not voided', async () => {
    knightPool.reset.mockRejectedValue(new Error('redis down'));
    knightPool.getAll.mockResolvedValueOnce([
      { value: String(CLEAN), score: 0 },
      { value: String(HELD), score: 0 },
    ]);

    const served = await getImagesQueue({ playerId: PLAYER, imageCount: 10 });

    expect(served.map((i) => i.id)).toEqual([CLEAN]);
    expect(voidedIds()).toEqual([]);
    expect(mockClearRatings).not.toHaveBeenCalled();
  });

  it('(b) control: a queue read with nothing held voids nothing', async () => {
    knightPool.getAll.mockResolvedValueOnce([{ value: String(CLEAN), score: 0 }]);

    await getImagesQueue({ playerId: PLAYER, imageCount: 10 });

    expect(voidedIds()).toEqual([]);
    expect(redisMock.sysRedis.incr).not.toHaveBeenCalled();
    expect(mockClearRatings).not.toHaveBeenCalled();
  });

  it('(c) a failed tally clear does not fail the queue read', async () => {
    mockClearRatings.mockRejectedValueOnce(new Error('redis down'));
    knightPool.getAll.mockResolvedValueOnce([
      { value: String(CLEAN), score: 0 },
      { value: String(HELD), score: 0 },
    ]);

    const served = await getImagesQueue({ playerId: PLAYER, imageCount: 10 });

    expect(served.map((i) => i.id)).toEqual([CLEAN]);
  });

  it('(c) a failed void does not fail the queue read', async () => {
    mockCh.insert.mockRejectedValue(new Error('clickhouse down'));
    knightPool.getAll.mockResolvedValueOnce([
      { value: String(CLEAN), score: 0 },
      { value: String(HELD), score: 0 },
    ]);

    const served = await getImagesQueue({ playerId: PLAYER, imageCount: 10 });

    expect(served.map((i) => i.id)).toEqual([CLEAN]);
  });
});

describe('leaving the queues after a moderator rating', () => {
  it('takes the image out of its queue and drops its vote tally', async () => {
    knightPool.exists.mockImplementation(async (id: number) => id === CLEAN);

    await leaveQueuesAfterModeratorRating(CLEAN);

    expect(knightPool.reset).toHaveBeenCalledWith({ id: CLEAN });
    expect(mockClearRatings).toHaveBeenCalledWith([CLEAN]);
  });

  it('a failed tally clear is logged and does not throw', async () => {
    knightPool.exists.mockImplementation(async (id: number) => id === CLEAN);
    mockClearRatings.mockRejectedValueOnce(new Error('redis down'));

    await expect(leaveQueuesAfterModeratorRating(CLEAN)).resolves.toBeUndefined();
    expect(handleLogError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'redis down' }),
      'new-order-mod-rating-queue-cleanup'
    );
  });

  it('takes an image out of the Inquisitor queue too', async () => {
    knightPool.exists.mockResolvedValue(false);
    inquisitorPool.exists.mockImplementation(async (id: number) => id === CLEAN);

    await leaveQueuesAfterModeratorRating(CLEAN);

    expect(inquisitorPool.reset).toHaveBeenCalledWith({ id: CLEAN });
    expect(mockClearRatings).toHaveBeenCalledWith([CLEAN]);
  });

  it('control: an image in no queue is left alone', async () => {
    inquisitorPool.exists.mockResolvedValue(false);
    knightPool.exists.mockResolvedValue(false);

    await leaveQueuesAfterModeratorRating(CLEAN);

    expect(knightPool.reset).not.toHaveBeenCalled();
    expect(mockClearRatings).not.toHaveBeenCalled();
    expect(handleLogError).not.toHaveBeenCalled();
  });
});
