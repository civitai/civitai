import { describe, it, expect, vi, beforeEach } from 'vitest';

// A Knight vote is graded when it is cast only if that vote decided the image. Until then it stays
// Pending and the decision grades it (the settle rewrites only Pending votes); a round that ends
// undecided has its votes voided.

const {
  counter,
  knightPool,
  inquisitorPool,
  ratingsCounter,
  mockCh,
  mockClearRatings,
  mockUpdateLevel,
} = vi.hoisted(() => {
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
    mockUpdateLevel: vi.fn(),
  };
});

vi.mock('~/server/games/new-order/utils', () => ({
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
  runClickHouseRead: (read: () => unknown) => read(),
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
  updateImageNsfwLevel: mockUpdateLevel,
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

import { addImageRating } from '~/server/services/games/new-order.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { NsfwLevel, NewOrderImageRatingStatus } from '~/server/common/enums';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

const CLEAN = 1;
const PLAYER = 5;

const rows: Record<number, { needsReview: string | null }> = {
  [CLEAN]: { needsReview: null },
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
  redisMock.redis.exists.mockResolvedValue(1);
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
  // updatePendingImageRatings, run when this vote decides the image
  mockCh.$query.mockResolvedValue([]);
  mockCh.$exec.mockResolvedValue(undefined);
  dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
});

// The image is XXX and the Knight vote limit is 5. `voteNumber` is the vote being cast; `tally` is
// the weighted tally the consensus check reads (a score of 10 000 on one level is a consensus, 100
// is not).
async function castVote({
  voteNumber,
  rating,
  tally,
}: {
  voteNumber: number;
  rating: NsfwLevel;
  tally: { level: NsfwLevel; score: number };
}) {
  knightPool.exists.mockImplementation(async (id: number) => id === CLEAN);
  knightPool.getCount.mockResolvedValue(voteNumber - 1);
  knightPool.increment.mockResolvedValue(voteNumber);
  ratingsCounter.getAll.mockResolvedValue([{ value: `Knight-${tally.level}`, score: tally.score }]);
  const tracker = { newOrderImageRating: vi.fn().mockResolvedValue(undefined) };
  await addImageRating({ playerId: PLAYER, imageId: CLEAN, rating, chTracker: tracker as any });
  const calls = tracker.newOrderImageRating.mock.calls;
  return calls.length ? (calls[0][0].status as NewOrderImageRatingStatus) : 'not recorded';
}

const voidedIds = () =>
  mockCh.insert.mock.calls
    .filter(([args]) => args.table === 'knights_rating_updates_buffer')
    .flatMap(([args]) => args.values as { imageId: number; rating: null }[])
    .map((v) => {
      expect(v.rating).toBeNull();
      return v.imageId;
    });

const NO_CONSENSUS = { level: NsfwLevel.X, score: 100 };
const CONSENSUS_X = { level: NsfwLevel.X, score: 10_000 };

describe('grading a Knight vote when it is cast', () => {
  it('vote 5 with no decision stays Pending', async () => {
    expect(await castVote({ voteNumber: 5, rating: NsfwLevel.XXX, tally: NO_CONSENSUS })).toBe(
      NewOrderImageRatingStatus.Pending
    );
    expect(mockUpdateLevel).not.toHaveBeenCalled();
    expect(voidedIds()).toEqual([]);
  });

  it('vote 5 that decides is graded against the decided level', async () => {
    mockUpdateLevel.mockResolvedValue(NsfwLevel.X);
    expect(await castVote({ voteNumber: 5, rating: NsfwLevel.X, tally: CONSENSUS_X })).toBe(
      NewOrderImageRatingStatus.Correct
    );

    vi.clearAllMocks();
    mockUpdateLevel.mockResolvedValue(NsfwLevel.X);
    expect(await castVote({ voteNumber: 5, rating: NsfwLevel.XXX, tally: CONSENSUS_X })).toBe(
      NewOrderImageRatingStatus.Failed
    );
  });

  it('a vote past the limit is not recorded; it ends the undecided round and voids its votes', async () => {
    expect(await castVote({ voteNumber: 6, rating: NsfwLevel.X, tally: NO_CONSENSUS })).toBe(
      'not recorded'
    );
    expect(knightPool.reset).toHaveBeenCalledWith({ id: CLEAN });
    expect(voidedIds()).toEqual([CLEAN]);
  });

  it('control: a vote below the limit voids nothing', async () => {
    expect(await castVote({ voteNumber: 3, rating: NsfwLevel.X, tally: NO_CONSENSUS })).toBe(
      NewOrderImageRatingStatus.Pending
    );
    expect(knightPool.reset).not.toHaveBeenCalled();
    expect(voidedIds()).toEqual([]);
  });
});
