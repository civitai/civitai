import { describe, it, expect, vi, beforeEach } from 'vitest';

// The ratings table keeps one row per (userId, imageId), so a second vote on a re-queued image
// would replace the player's settled row with a Pending one. The submit path refuses it.

const { counter, knightPool, ratingsCounter, mockCh } = vi.hoisted(() => {
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
    ratingsCounter: counter(),
    mockCh: { $query: vi.fn(), $exec: vi.fn(), insert: vi.fn() },
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
    Inquisitor: { a: [], b: [] },
  },
  DEFAULT_POOL_QUOTAS: {},
  checkVotingRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  computePoolTargets: vi.fn(),
  getActiveSlot: vi.fn().mockResolvedValue('a'),
  clearImageRatings: vi.fn(),
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

import { addImageRating } from '~/server/services/games/new-order.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { NsfwLevel } from '~/server/common/enums';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

const IMAGE = 1;
const PLAYER = 5;
const STATS = { exp: 0, smites: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.image.findUnique.mockImplementation(async (args: any) =>
    args.where.id === IMAGE
      ? Object.fromEntries(
          Object.keys(args.select).map((k) => [
            k,
            ({ id: IMAGE, nsfwLevel: NsfwLevel.XXX, metadata: {} } as Record<string, unknown>)[k],
          ])
        )
      : null
  );
  dbMock.dbRead.newOrderPlayer.findUnique.mockResolvedValue({
    user: {},
    rankType: NewOrderRankType.Knight,
    rank: { name: 'Knight' },
    startAt: new Date('2026-01-01T00:00:00Z'),
    stats: STATS,
  });
  redisMock.redis.exists.mockResolvedValue(1);
  redisMock.redis.sIsMember.mockResolvedValue(false);
  redisMock.sysRedis.sIsMember.mockResolvedValue(false);
  redisMock.sysRedis.sMembers.mockResolvedValue([]);
  redisMock.sysRedis.incr.mockResolvedValue(1);
  redisMock.sysRedis.get.mockResolvedValue(String(Date.now()));
  mockCh.insert.mockResolvedValue(undefined);
  mockCh.$query.mockResolvedValue([]);
  mockCh.$exec.mockResolvedValue(undefined);
  const chain: any = { sAdd: () => chain, expire: () => chain, exec: async () => [] };
  redisMock.redis.multi.mockReturnValue(chain);
  knightPool.exists.mockImplementation(async (id: number) => id === IMAGE);
  knightPool.getCount.mockResolvedValue(0);
  knightPool.increment.mockResolvedValue(1);
  dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
});

async function castVote() {
  const tracker = { newOrderImageRating: vi.fn().mockResolvedValue(undefined) };
  const result = await addImageRating({
    playerId: PLAYER,
    imageId: IMAGE,
    rating: NsfwLevel.X,
    chTracker: tracker as any,
  });
  return { result, written: tracker.newOrderImageRating.mock.calls };
}

describe('refusing a second vote on an image the player already rated', () => {
  it('writes nothing and counts nothing for a re-queued image the player rated', async () => {
    redisMock.redis.sIsMember.mockResolvedValue(true);

    const { result, written } = await castVote();

    expect(result).toEqual({ stats: expect.objectContaining(STATS) });
    expect(written).toEqual([]);
    expect(knightPool.increment).not.toHaveBeenCalled();
    expect(ratingsCounter.increment).not.toHaveBeenCalled();
  });

  it('builds the rated set from votes at every rank, so a promoted Knight is still refused', async () => {
    redisMock.redis.exists.mockResolvedValue(0);
    mockCh.$query.mockResolvedValue([{ imageId: IMAGE }]);
    const stored = new Set<string>();
    redisMock.redis.sAdd.mockImplementation(async (_key: string, members: string[]) => {
      members.forEach((m) => stored.add(m));
      return members.length;
    });
    redisMock.redis.sIsMember.mockImplementation(async (_key: string, id: string) =>
      stored.has(id)
    );

    const { written } = await castVote();

    const sql = JSON.stringify(mockCh.$query.mock.calls[0]);
    expect(sql).not.toMatch(/rank\s*=/);
    expect(written).toEqual([]);
    expect(knightPool.increment).not.toHaveBeenCalled();
  });

  it('control: a first vote on an unrated image is written', async () => {
    const { written } = await castVote();

    expect(written).toHaveLength(1);
    expect(knightPool.increment).toHaveBeenCalledWith({ id: IMAGE });
  });

  it('fails open: a Redis error on the check still lets the vote through', async () => {
    redisMock.redis.sIsMember.mockRejectedValue(new Error('redis down'));

    const { written } = await castVote();

    expect(written).toHaveLength(1);
    expect(knightPool.increment).toHaveBeenCalledWith({ id: IMAGE });
  });
});
