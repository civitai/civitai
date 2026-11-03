import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { addImageRating } from '~/server/services/games/new-order.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import { NsfwLevel } from '~/server/common/enums';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

const IMAGE = 1;
const PLAYER = 5;
const STATS = { exp: 0, smites: 0 };

const sets = new Map<string, Set<string>>();
const ttls = new Set<string>();

type ChRow = { imageId: number; rank: string; createdAt: string };
let chRows: ChRow[] = [];

// Honours the rank and startAt predicates in the SQL, so a filter put back in the service
// changes what the rebuild returns.
function runRatingsQuery(sql: string) {
  const rank = sql.match(/rank\s*=\s*'(\w+)'/)?.[1];
  const since = sql.match(/createdAt\s*>=\s*parseDateTimeBestEffort\('([^']+)'\)/)?.[1];
  return chRows
    .filter((r) => !rank || r.rank === rank)
    .filter((r) => !since || new Date(r.createdAt) >= new Date(since))
    .map((r) => ({ imageId: r.imageId }));
}

const ratedKey = `${REDIS_KEYS.NEW_ORDER.RATED}:${5}`;

beforeEach(() => {
  vi.clearAllMocks();
  ttls.clear();
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
  redisMock.redis.exists.mockImplementation(async (key: string) => (sets.has(key) ? 1 : 0));
  redisMock.redis.sIsMember.mockImplementation(
    async (key: string, id: string) => sets.get(key)?.has(id) ?? false
  );
  redisMock.redis.sAdd.mockImplementation(async (key: string, members: string[]) => {
    const set = sets.get(key) ?? new Set<string>();
    members.forEach((m) => set.add(m));
    sets.set(key, set);
    return members.length;
  });
  redisMock.redis.expire.mockImplementation(async (key: string) => {
    if (sets.has(key)) ttls.add(key);
    return true;
  });
  redisMock.redis.rename.mockImplementation(async (from: string, to: string) => {
    if (!ttls.has(from)) throw new Error('renamed a set that has no expiry');
    sets.set(to, sets.get(from)!);
    sets.delete(from);
    ttls.delete(from);
    ttls.add(to);
    return 'OK';
  });
  redisMock.redis.unlink.mockImplementation(async (key: string) => (sets.delete(key) ? 1 : 0));
  // The real script is covered in redis/__tests__/atomic.append-if-exists.test.ts.
  redisMock.redis.eval.mockImplementation(
    async (_script: string, { keys, arguments: argv }: { keys: string[]; arguments: string[] }) => {
      if (!sets.has(keys[0])) return 0;
      sets.get(keys[0])!.add(argv[0]);
      return 1;
    }
  );
  redisMock.sysRedis.sIsMember.mockResolvedValue(false);
  redisMock.sysRedis.sMembers.mockResolvedValue([]);
  redisMock.sysRedis.incr.mockResolvedValue(1);
  redisMock.sysRedis.get.mockResolvedValue(String(Date.now()));
  mockCh.insert.mockResolvedValue(undefined);
  mockCh.$exec.mockResolvedValue(undefined);
  const chain: any = {
    sAdd: (key: string, members: string[]) => {
      const set = sets.get(key) ?? new Set<string>();
      members.forEach((m) => set.add(m));
      sets.set(key, set);
      return chain;
    },
    expire: () => chain,
    exec: async () => [],
  };
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
    sets.set(ratedKey, new Set(['0', String(IMAGE)]));

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
    sets.set(ratedKey, new Set(['0', String(IMAGE)]));
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

  it('does not rebuild under the lock when the warm-up failed: the vote goes through', async () => {
    mockCh.$query.mockRejectedValue(new Error('clickhouse down'));

    const { written } = await castVote();

    expect(written).toHaveLength(1);
    expect(mockCh.$query).toHaveBeenCalledTimes(1);
  });

  it('builds under a temp key with an expiry and renames it in', async () => {
    chRows = [{ imageId: IMAGE + 1, rank: 'Knight', createdAt: '2026-03-01T00:00:00Z' }];

    await castVote();

    const written = redisMock.redis.sAdd.mock.calls.map(([key]) => key as string);
    expect(written.length).toBeGreaterThan(0);
    written.forEach((key) => expect(key).toMatch(/:build:/));
    expect(redisMock.redis.rename).toHaveBeenCalledWith(written[0], ratedKey);
    expect([...sets.keys()]).toEqual([ratedKey]);
    expect(sets.get(ratedKey)).toContain(String(IMAGE + 1));
  });

  it('leaves the real key absent when the build dies part-way', async () => {
    chRows = Array.from({ length: 1500 }, (_, i) => ({
      imageId: 100 + i,
      rank: 'Knight',
      createdAt: '2026-03-01T00:00:00Z',
    }));
    const add = redisMock.redis.sAdd.getMockImplementation()!;
    redisMock.redis.sAdd.mockImplementation(async (...args: any[]) => {
      if (redisMock.redis.sAdd.mock.calls.length > 1) throw new Error('redis dropped');
      return add(...args);
    });

    const { written } = await castVote();

    expect(sets.has(ratedKey)).toBe(false);
    expect([...sets.keys()]).toEqual([]);
    expect(written).toHaveLength(1);
  });
});

describe('recording a vote in the rated set', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('does not create the set when it is missing, so it is never passed off as complete', async () => {
    mockCh.$query.mockRejectedValue(new Error('clickhouse down'));

    await castVote();
    await flush();

    expect(sets.has(ratedKey)).toBe(false);
  });

  it('appends to a set that already exists', async () => {
    sets.set(ratedKey, new Set(['0']));

    await castVote();
    await flush();

    expect(sets.get(ratedKey)).toContain(String(IMAGE));
  });
});
