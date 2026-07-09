import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pins the listForModel SQL after the two new UNION branches land
 * (publisher_all_my_models and viewer_personal). Like the existing
 * block-registry.service.test.ts file we capture the SQL template
 * literal and assert on its shape — no DB needed.
 *
 * Invariants under test:
 *   1. Four source ranks total, in the documented order
 *   2. The publisher_all_my_models branch joins on Model.userId = bus.user_id
 *   3. The viewer_personal branch filters bus.user_id by the passed
 *      viewerUserId param (or -1 fallback for anon)
 *   4. The viewer branch has three NOT EXISTS clauses (rank 1, 2, 3
 *      suppression)
 *   5. Cache is disabled when viewerUserId != null — neither get nor set
 *      hit Redis on that path
 */

const { mockDbRead, mockDbWrite, mockRedis, mockSysRedis } = vi.hoisted(() => {
  const dbRead = {
    $queryRaw: vi.fn<(...args: any[]) => Promise<any[]>>(async () => []),
    modelBlockInstall: { findUnique: vi.fn<(...args: any[]) => Promise<any>>() },
    appBlock: { findUnique: vi.fn<(...args: any[]) => Promise<any>>() },
    blockUserSubscription: {
      findMany: vi.fn<(...args: any[]) => Promise<any[]>>(async () => []),
    },
  };
  const dbWrite = {
    appBlock: { findUnique: vi.fn<(...args: any[]) => Promise<any>>() },
    modelBlockInstall: {
      upsert: vi.fn<(...args: any[]) => Promise<any>>(async () => ({
        blockInstanceId: 'bki_test',
      })),
      deleteMany: vi.fn<(...args: any[]) => Promise<any>>(),
      update: vi.fn<(...args: any[]) => Promise<any>>(),
      updateMany: vi.fn<(...args: any[]) => Promise<any>>(),
    },
    blockUserSubscription: {
      upsert: vi.fn<(...args: any[]) => Promise<any>>(),
      findUnique: vi.fn<(...args: any[]) => Promise<any>>(),
      delete: vi.fn<(...args: any[]) => Promise<any>>(),
    },
  };
  const redis = {
    packed: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => 0),
    scanIterator: async function* () {},
  };
  const sysRedis = { sMembers: vi.fn(async () => []) };
  return { mockDbRead: dbRead, mockDbWrite: dbWrite, mockRedis: redis, mockSysRedis: sysRedis };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  sysRedis: mockSysRedis,
  REDIS_KEYS: {
    BLOCKS: { REGISTRY: 'r', TOKEN_RATE_LIMIT: 'rl', REVOKED_INSTANCE: 'rev' },
  },
  REDIS_SYS_KEYS: { BLOCKS: { EMERGENCY_KILL_LIST: 'kill' } },
}));

function capturedSql(): string {
  const lastCall = mockDbRead.$queryRaw.mock.calls.at(-1);
  if (!lastCall) return '';
  const strings = lastCall[0] as unknown as TemplateStringsArray;
  const values = lastCall.slice(1);
  let sql = '';
  for (let i = 0; i < strings.length; i++) {
    sql += strings[i];
    if (i < values.length) sql += `$${i + 1}`;
  }
  return sql;
}

describe('BlockRegistry.listForModel — precedence ladder SQL', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockReset();
    mockDbRead.$queryRaw.mockResolvedValue([]);
    mockRedis.packed.get.mockReset();
    mockRedis.packed.get.mockResolvedValue(null);
    mockRedis.packed.set.mockReset();
    mockRedis.packed.set.mockResolvedValue(undefined);
  });

  it('emits exactly four source_rank values (1, 2, 3, 4)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({ modelId: 1, slotId: 'model.sidebar_top' });
    const sql = capturedSql();
    expect(sql).toMatch(/1 AS source_rank/);
    expect(sql).toMatch(/2 AS source_rank/);
    expect(sql).toMatch(/3 AS source_rank/);
    expect(sql).toMatch(/4 AS source_rank/);
  });

  it('publisher_all_my_models branch joins on Model.userId = bus.user_id', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({ modelId: 1, slotId: 'model.sidebar_top' });
    const sql = capturedSql();
    // The publisher branch is the rank-2 SELECT — find it and assert
    // the dynamic JOIN with Model.userId is present.
    expect(sql).toMatch(/bus\.scope\s*=\s*'publisher_all_my_models'/);
    expect(sql).toMatch(/"Model"[\s\S]*"userId"\s*=\s*bus\.user_id/);
  });

  it('viewer_personal branch filters by passed viewerUserId', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({
      modelId: 1,
      slotId: 'model.sidebar_top',
      viewerUserId: 8753561,
    });
    const sql = capturedSql();
    expect(sql).toMatch(/bus\.scope\s*=\s*'viewer_personal'/);
    expect(sql).toMatch(/bus\.user_id\s*=\s*\$\d+/);
    // The viewerUserId param should be 8753561 somewhere in the values list.
    const params = mockDbRead.$queryRaw.mock.calls.at(-1)?.slice(1) ?? [];
    expect(params).toContain(8753561);
  });

  it('falls back to -1 sentinel for anon viewers (matches no rows)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({ modelId: 1, slotId: 'model.sidebar_top' });
    // The viewer_personal branch should be parameterised with -1 (anon).
    const params = mockDbRead.$queryRaw.mock.calls.at(-1)?.slice(1) ?? [];
    expect(params).toContain(-1);
  });

  it('contains 5+ NOT EXISTS suppression clauses across all branches', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({
      modelId: 1,
      slotId: 'model.sidebar_top',
      viewerUserId: 42,
    });
    const sql = capturedSql();
    // Rank 2 (publisher subs): 1 NOT EXISTS (per-model install suppresses).
    // Rank 3 (platform defaults): 1 NOT EXISTS (per-model install suppresses).
    // Rank 4 (viewer subs): 3 NOT EXISTS (rank 1, 2, 3 all suppress).
    // Total: at least 5.
    const matches = sql.match(/NOT\s+EXISTS\s*\(/gi) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });

  it('orders by source_rank ASC so per-model installs win over subscriptions', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({ modelId: 1, slotId: 'model.sidebar_top' });
    expect(capturedSql()).toMatch(/ORDER BY source_rank ASC/);
  });

  it('matches slot via manifest @> {targets:[{slotId}]} for subscription branches', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({ modelId: 1, slotId: 'model.sidebar_top' });
    const sql = capturedSql();
    // Two subscription branches both target via @> jsonb containment.
    const matches = sql.match(/ab\.manifest @>/g) ?? [];
    expect(matches.length).toBe(2);
  });
});

describe('BlockRegistry.listForModel — cache behaviour with viewer', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockReset();
    mockDbRead.$queryRaw.mockResolvedValue([]);
    mockRedis.packed.get.mockReset();
    mockRedis.packed.set.mockReset();
  });

  it('reads + writes Redis cache when viewerUserId is unset', async () => {
    mockRedis.packed.get.mockResolvedValue(null);
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({ modelId: 1, slotId: 'model.sidebar_top' });
    expect(mockRedis.packed.get).toHaveBeenCalled();
    expect(mockRedis.packed.set).toHaveBeenCalled();
  });

  it('does NOT touch Redis when viewerUserId is set (per-viewer correctness)', async () => {
    mockRedis.packed.get.mockResolvedValue(null);
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({
      modelId: 1,
      slotId: 'model.sidebar_top',
      viewerUserId: 42,
    });
    expect(mockRedis.packed.get).not.toHaveBeenCalled();
    expect(mockRedis.packed.set).not.toHaveBeenCalled();
  });

  it('two different viewers do not see each other\'s cached results', async () => {
    // If the cache leaked, the second call's results would match the first
    // call's. Since we don't write the cache when viewerUserId is set, the
    // second call always hits the DB — observable as two $queryRaw calls.
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({
      modelId: 1,
      slotId: 'model.sidebar_top',
      viewerUserId: 1,
    });
    await BlockRegistry.listForModel({
      modelId: 1,
      slotId: 'model.sidebar_top',
      viewerUserId: 2,
    });
    expect(mockDbRead.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
