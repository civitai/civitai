import { beforeEach, describe, expect, it, vi } from 'vitest';

// `followed` on the Postgres feed path only pushed a `userId IN (...)` clause when the
// viewer's follow set was non-empty. A user who follows nobody therefore got the
// UNFILTERED GLOBAL feed rendered under the "Following" label — the same failure mode the
// adjacent `newCreators` guard already prevents with `1 = 0`, and the same outcome the
// BitDex path produces by bailing out on an empty follow set.
//
// The generated SQL is the observable: mock the query executor and read the clause.

const { queryCaptureMock, getUserFollowsMock } = vi.hoisted(() => ({
  queryCaptureMock: vi.fn(async () => [] as unknown[]),
  getUserFollowsMock: vi.fn(),
}));

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/cache-helpers')>();
  return { ...actual, queryCacheRaw: () => queryCaptureMock };
});

vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/redis/caches')>();
  return { ...actual, getUserFollows: getUserFollowsMock };
});

vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn(async () => {}),
  safeError: (e: unknown) => e,
}));

// The assertion is on the SQL this call BUILDS, not on what it returns. The row set is
// empty, so every downstream Prisma read is incidental — hand them all an empty result.
vi.mock('~/server/db/client', () => {
  const stub = (): any => new Proxy(async () => [], { get: () => stub() });
  return { dbRead: stub(), dbWrite: stub() };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: {
      get: vi.fn().mockResolvedValue('[]'),
      set: vi.fn().mockResolvedValue(undefined),
      packed: { get: vi.fn(), set: vi.fn() },
    },
    sysRedis: {},
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
  };
});

import { getAllImages } from '../image.service';

const baseInput = {
  limit: 10,
  browsingLevel: 1,
  period: 'AllTime',
  periodMode: 'published',
  sort: 'Newest',
  followed: true,
  userId: 500,
  user: { id: 500, isModerator: false },
  include: [],
} as any;

const capturedSql = () => {
  expect(queryCaptureMock).toHaveBeenCalled();
  return (queryCaptureMock.mock.calls[0][0] as unknown as { sql: string }).sql;
};

describe('getAllImages followed filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryCaptureMock.mockResolvedValue([]);
  });

  it('returns nothing when the viewer follows nobody', async () => {
    getUserFollowsMock.mockResolvedValue([]);

    await getAllImages(baseInput);

    expect(capturedSql()).toContain('1 = 0');
  });

  it('filters to the follow set when the viewer follows someone', async () => {
    getUserFollowsMock.mockResolvedValue([11, 22]);

    await getAllImages(baseInput);

    const sql = capturedSql();
    expect(sql).toContain('i."userId" IN');
    expect(sql).not.toContain('1 = 0');
  });
});
