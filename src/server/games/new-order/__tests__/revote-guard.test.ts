import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ChClient from '~/server/clickhouse/client';
import type * as ErrorHandling from '~/server/utils/errorHandling';

// The ratings table keeps one row per (userId, imageId), so a second vote on a re-queued image
// would replace the player's settled row with a Pending one. The submit path refuses it.

const { counter, knightPool, ratingsCounter, mockCh, lockMock } = vi.hoisted(() => {
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
    lockMock: vi.fn(),
  };
});

// Wholesale on purpose: the real module builds Redis-backed counters at import time.
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
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ChClient>()),
  clickhouse: mockCh,
}));
vi.mock('~/server/utils/errorHandling', async (importOriginal) => ({
  ...(await importOriginal<typeof ErrorHandling>()),
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
vi.mock('~/server/utils/distributed-lock', () => ({ withDistributedLock: lockMock }));
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

import { handleLogError } from '~/server/utils/errorHandling';
import { addImageRating, RATED_SET_COMPLETE } from '~/server/services/games/new-order.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import { CacheTTL } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

const IMAGE = 1;
const PLAYER = 5;
const STATS = { exp: 0, smites: 0 };

const sets = new Map<string, Set<string>>();
const ttlSeconds = new Map<string, number>();
const allTtls: number[] = [];
let execCalls = 0;
let failExecAt = 0;

type ChRow = { imageId: number; rank: string; createdAt: string };
let chRows: ChRow[] = [];

// Honours the rank and startAt predicates in the SQL, so a filter put back in the service
// changes what the rebuild returns.
function runRatingsQuery(sql: string) {
  const rank = sql.match(/rank\s*=\s*'(\w+)'/)?.[1];
  const since = sql.match(/createdAt\s*>=\s*parseDateTimeBestEffort\('([^']+)'\)/)?.[1];
  // Fail closed: a filter spelled any other way must not be silently ignored.
  if ((/\brank\b/.test(sql) && !rank) || (/createdAt/.test(sql) && !since)) {
    throw new Error(`unrecognised rank/createdAt predicate: ${sql}`);
  }
  return chRows
    .filter((r) => !rank || r.rank === rank)
    .filter((r) => !since || new Date(r.createdAt) >= new Date(since))
    .map((r) => ({ imageId: r.imageId }));
}

const ratedKey = `${REDIS_KEYS.NEW_ORDER.RATED}:${5}`;

beforeEach(() => {
  vi.clearAllMocks();
  ttlSeconds.clear();
  allTtls.length = 0;
  execCalls = 0;
  failExecAt = 0;
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
  lockMock.mockImplementation((_opts: unknown, fn: () => unknown) => fn());
  sets.clear();
  chRows = [];
  mockCh.$query.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) =>
    runRatingsQuery(String.raw({ raw: strings }, ...values))
  );
  redisMock.redis.sIsMember.mockImplementation(
    async (key: string, id: string) => sets.get(key)?.has(id) ?? false
  );
  // One multi() per call; exec applies SADD then EXPIRE on the single key, or throws when told to.
  redisMock.redis.multi.mockImplementation(() => {
    const ops: Array<() => void> = [];
    const chain: any = {
      sAdd: (key: string, members: string[]) => {
        ops.push(() => {
          const set = sets.get(key) ?? new Set<string>();
          members.forEach((m) => set.add(m));
          sets.set(key, set);
        });
        return chain;
      },
      expire: (key: string, seconds: number) => {
        ops.push(() => {
          ttlSeconds.set(key, seconds);
          allTtls.push(seconds);
        });
        return chain;
      },
      exec: async () => {
        if (++execCalls === failExecAt) throw new Error('redis dropped');
        ops.forEach((op) => op());
        return [];
      },
    };
    return chain;
  });
  // The real script is exercised by the atomic helper's own tests; this applies its effect.
  redisMock.redis.eval.mockImplementation(
    async (_script: string, { keys, arguments: argv }: { keys: string[]; arguments: string[] }) => {
      const set = sets.get(keys[0]) ?? new Set<string>();
      set.add(argv[0]);
      sets.set(keys[0], set);
      ttlSeconds.set(keys[0], Number(argv[1]));
      return 1;
    }
  );
  redisMock.sysRedis.sIsMember.mockResolvedValue(false);
  redisMock.sysRedis.sMembers.mockResolvedValue([]);
  redisMock.sysRedis.incr.mockResolvedValue(1);
  redisMock.sysRedis.get.mockResolvedValue(String(Date.now()));
  mockCh.insert.mockResolvedValue(undefined);
  mockCh.$exec.mockResolvedValue(undefined);
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
    sets.set(ratedKey, new Set([RATED_SET_COMPLETE, String(IMAGE)]));

    const { result, written } = await castVote();

    expect(result).toEqual({ stats: expect.objectContaining(STATS) });
    expect(written).toEqual([]);
    expect(knightPool.increment).not.toHaveBeenCalled();
    expect(ratingsCounter.increment).not.toHaveBeenCalled();
  });

  it('refuses a vote the player cast at an earlier rank, so a promoted Knight is still refused', async () => {
    chRows = [{ imageId: IMAGE, rank: 'Acolyte', createdAt: '2026-03-01T00:00:00Z' }];

    const { written } = await castVote();

    expect(written).toEqual([]);
    expect(knightPool.increment).not.toHaveBeenCalled();
  });

  it('refuses a vote settled before the player was reset, whose startAt moved forward', async () => {
    chRows = [{ imageId: IMAGE, rank: 'Knight', createdAt: '2025-12-01T00:00:00Z' }];

    const { written } = await castVote();

    expect(written).toEqual([]);
    expect(knightPool.increment).not.toHaveBeenCalled();
  });

  it('control: a first vote on an image with no rating row is written', async () => {
    chRows = [{ imageId: IMAGE + 1, rank: 'Knight', createdAt: '2026-03-01T00:00:00Z' }];

    const { written } = await castVote();

    expect(written).toHaveLength(1);
    expect(knightPool.increment).toHaveBeenCalledWith({ id: IMAGE });
  });

  it('fails open: a Redis error on the check still lets the vote through', async () => {
    sets.set(ratedKey, new Set([RATED_SET_COMPLETE, String(IMAGE)]));
    redisMock.redis.sIsMember.mockRejectedValue(new Error('redis down'));

    const { written } = await castVote();

    expect(written).toHaveLength(1);
    expect(knightPool.increment).toHaveBeenCalledWith({ id: IMAGE });
  });
});

describe('warming the rated set', () => {
  it('reads the history before the per-image lock is taken', async () => {
    const order: string[] = [];
    mockCh.$query.mockImplementation(async () => {
      order.push('rebuild');
      return [];
    });
    lockMock.mockImplementation((_opts: unknown, fn: () => unknown) => {
      order.push('lock');
      return fn();
    });

    await castVote();

    expect(order).toEqual(['rebuild', 'lock']);
  });

  it('completes a set that has no sentinel by union, adding the sentinel last', async () => {
    sets.set(ratedKey, new Set(['900']));
    chRows = [{ imageId: IMAGE + 1, rank: 'Knight', createdAt: '2026-03-01T00:00:00Z' }];

    await castVote();

    expect(mockCh.$query).toHaveBeenCalledTimes(1);
    expect([...sets.get(ratedKey)!]).toEqual(
      expect.arrayContaining(['900', '2', RATED_SET_COMPLETE])
    );
    expect([...sets.get(ratedKey)!].indexOf(RATED_SET_COMPLETE)).toBeGreaterThan(
      [...sets.get(ratedKey)!].indexOf('2')
    );
  });

  it('rebuilds an old-format set that holds only the numeric sentinel', async () => {
    sets.set(ratedKey, new Set(['0', '900']));
    chRows = [{ imageId: IMAGE + 1, rank: 'Knight', createdAt: '2026-03-01T00:00:00Z' }];

    await castVote();

    expect(mockCh.$query).toHaveBeenCalledTimes(1);
    expect([...sets.get(ratedKey)!]).toEqual(expect.arrayContaining(['2', RATED_SET_COMPLETE]));
  });

  it('does not query ClickHouse again for a set that carries the sentinel', async () => {
    sets.set(ratedKey, new Set([RATED_SET_COMPLETE]));

    await castVote();

    expect(mockCh.$query).not.toHaveBeenCalled();
  });

  it('writes the sentinel only after every chunk: a build that dies keeps its members but not the sentinel', async () => {
    chRows = Array.from({ length: 1500 }, (_, i) => ({
      imageId: 100 + i,
      rank: 'Knight',
      createdAt: '2026-03-01T00:00:00Z',
    }));
    failExecAt = 2;

    const { written } = await castVote();

    expect(sets.get(ratedKey)!.size).toBeGreaterThanOrEqual(1000);
    expect(sets.get(ratedKey)!.has(RATED_SET_COMPLETE)).toBe(false);
    expect(written).toHaveLength(1);
  });

  it('expires the set after a day, in the unit the client expects', async () => {
    chRows = [{ imageId: IMAGE + 1, rank: 'Knight', createdAt: '2026-03-01T00:00:00Z' }];
    await castVote();

    expect(allTtls.length).toBeGreaterThan(0);
    expect(allTtls.every((t) => t === CacheTTL.day)).toBe(true);
  });

  it('keeps the warm-up failure from triggering a second ClickHouse read under the lock', async () => {
    mockCh.$query.mockRejectedValue(new Error('clickhouse down'));

    const { written } = await castVote();

    expect(written).toHaveLength(1);
    expect(mockCh.$query).toHaveBeenCalledTimes(1);
  });
});

describe('recording a vote in the rated set', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('creates a missing set without the sentinel, which the next warm-up completes', async () => {
    mockCh.$query.mockRejectedValueOnce(new Error('clickhouse down'));

    await castVote();
    await flush();

    expect([...sets.get(ratedKey)!]).toEqual([String(IMAGE)]);
    expect(ttlSeconds.get(ratedKey)).toBe(CacheTTL.day);

    chRows = [{ imageId: 50, rank: 'Knight', createdAt: '2026-03-01T00:00:00Z' }];
    await castVote();

    expect([...sets.get(ratedKey)!]).toEqual(
      expect.arrayContaining([String(IMAGE), '50', RATED_SET_COMPLETE])
    );
  });

  it('appends to a set that already exists', async () => {
    sets.set(ratedKey, new Set([RATED_SET_COMPLETE]));

    await castVote();
    await flush();

    expect(sets.get(ratedKey)).toContain(String(IMAGE));
  });
});

describe('the append after a vote', () => {
  it('does not fail the vote when it rejects, and logs it', async () => {
    sets.set(ratedKey, new Set([RATED_SET_COMPLETE]));
    redisMock.redis.eval.mockRejectedValue(new Error('redis down'));

    const { written } = await castVote();

    expect(written).toHaveLength(1);
    expect(handleLogError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'redis down' }),
      'new-order-duplicate-vote-check',
      { playerId: PLAYER, imageId: IMAGE }
    );
  });

  it('completes before the per-image lock is released', async () => {
    sets.set(ratedKey, new Set([RATED_SET_COMPLETE]));
    const order: string[] = [];
    redisMock.redis.eval.mockImplementation(async () => {
      order.push('append');
      return 1;
    });
    lockMock.mockImplementation(async (_opts: unknown, fn: () => unknown) => {
      const result = await fn();
      order.push('release');
      return result;
    });

    await castVote();

    expect(order).toEqual(['append', 'release']);
  });
});
