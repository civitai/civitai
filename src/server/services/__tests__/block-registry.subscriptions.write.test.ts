import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Service-layer tests for the user-subscription writes:
 *   - listUserSubscriptions normalises empty target arrays to null
 *   - upsertSubscription requires status='approved' and serializes the
 *     update/create branches through the composite unique
 *   - deleteSubscription is idempotent (missing row → no-op) and refuses
 *     to delete a row owned by another user
 *   - listAvailable issues a SELECT with the slot/query/cursor predicates
 */

const { mockDbRead, mockDbWrite } = vi.hoisted(() => {
  const dbRead = {
    $queryRaw: vi.fn(async () => []),
    blockUserSubscription: { findMany: vi.fn(async () => []) },
  };
  const dbWrite = {
    appBlock: { findUnique: vi.fn() },
    blockUserSubscription: {
      upsert: vi.fn(async () => ({})),
      findUnique: vi.fn(),
      delete: vi.fn(async () => undefined),
    },
  };
  return { mockDbRead: dbRead, mockDbWrite: dbWrite };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/redis/client', () => ({
  redis: {
    packed: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => 0),
    scanIterator: async function* () {},
  },
  sysRedis: { sMembers: vi.fn(async () => []) },
  REDIS_KEYS: {
    BLOCKS: { REGISTRY: 'r', TOKEN_RATE_LIMIT: 'rl', REVOKED_INSTANCE: 'rev' },
  },
  REDIS_SYS_KEYS: { BLOCKS: { EMERGENCY_KILL_LIST: 'kill' } },
}));

describe('BlockRegistry.listUserSubscriptions', () => {
  beforeEach(() => {
    mockDbRead.blockUserSubscription.findMany.mockReset();
  });

  it('returns rows ordered by updatedAt desc with empty arrays normalised to null', async () => {
    const now = new Date();
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      {
        id: 'bus_one',
        scope: 'publisher_all_my_models',
        appBlockId: 'ab_one',
        targetModelTypes: [],
        targetBaseModels: ['Flux.1 D'],
        settings: { buzz_budget_per_gen: 50 },
        enabled: true,
        createdAt: now,
        updatedAt: now,
        appBlock: { blockId: 'generate-from-model', appId: 'oc_test', manifest: { name: 'Gen' } },
      },
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const out = await BlockRegistry.listUserSubscriptions(42);
    expect(out).toHaveLength(1);
    expect(out[0].targetModelTypes).toBeNull();
    expect(out[0].targetBaseModels).toEqual(['Flux.1 D']);
    expect(out[0].blockId).toBe('generate-from-model');
    expect(out[0].settings).toEqual({ buzz_budget_per_gen: 50 });
    const callArgs = mockDbRead.blockUserSubscription.findMany.mock.calls.at(-1)?.[0] as {
      where: { userId: number };
      orderBy: { updatedAt: string };
    };
    expect(callArgs.where.userId).toBe(42);
    expect(callArgs.orderBy.updatedAt).toBe('desc');
  });
});

describe('BlockRegistry.upsertSubscription', () => {
  beforeEach(() => {
    mockDbWrite.appBlock.findUnique.mockReset();
    mockDbWrite.blockUserSubscription.upsert.mockReset();
  });

  it('rejects an unknown app block', async () => {
    mockDbWrite.appBlock.findUnique.mockResolvedValue(null);
    const { BlockRegistry } = await import('../block-registry.service');
    await expect(
      BlockRegistry.upsertSubscription({
        userId: 1,
        appBlockId: 'ab_missing',
        scope: 'viewer_personal',
        targetModelTypes: null,
        targetBaseModels: null,
        settings: {},
        enabled: true,
      })
    ).rejects.toThrow();
    expect(mockDbWrite.blockUserSubscription.upsert).not.toHaveBeenCalled();
  });

  it('rejects an unapproved app block', async () => {
    mockDbWrite.appBlock.findUnique.mockResolvedValue({
      id: 'ab',
      blockId: 'b',
      appId: 'a',
      status: 'pending',
      manifest: {},
    });
    const { BlockRegistry } = await import('../block-registry.service');
    await expect(
      BlockRegistry.upsertSubscription({
        userId: 1,
        appBlockId: 'ab',
        scope: 'viewer_personal',
        targetModelTypes: null,
        targetBaseModels: null,
        settings: {},
        enabled: true,
      })
    ).rejects.toThrow();
  });

  it('writes through the (userId, appBlockId, scope) composite unique with empty arrays for null targets', async () => {
    mockDbWrite.appBlock.findUnique.mockResolvedValue({
      id: 'ab',
      blockId: 'generate-from-model',
      appId: 'a',
      status: 'approved',
      manifest: {},
    });
    const updatedAt = new Date();
    mockDbWrite.blockUserSubscription.upsert.mockResolvedValue({
      id: 'bus_new',
      scope: 'publisher_all_my_models',
      appBlockId: 'ab',
      targetModelTypes: [],
      targetBaseModels: [],
      settings: {},
      enabled: true,
      createdAt: updatedAt,
      updatedAt,
    });
    const { BlockRegistry } = await import('../block-registry.service');
    const out = await BlockRegistry.upsertSubscription({
      userId: 7,
      appBlockId: 'ab',
      scope: 'publisher_all_my_models',
      targetModelTypes: null,
      targetBaseModels: null,
      settings: { buzz_budget_per_gen: 25 },
      enabled: true,
    });
    expect(out.id).toBe('bus_new');
    expect(out.targetModelTypes).toBeNull();
    const args = mockDbWrite.blockUserSubscription.upsert.mock.calls.at(-1)?.[0] as {
      where: { userId_appBlockId_scope: { userId: number; appBlockId: string; scope: string } };
      create: { targetModelTypes: string[]; targetBaseModels: string[] };
    };
    expect(args.where.userId_appBlockId_scope).toEqual({
      userId: 7,
      appBlockId: 'ab',
      scope: 'publisher_all_my_models',
    });
    expect(args.create.targetModelTypes).toEqual([]);
    expect(args.create.targetBaseModels).toEqual([]);
  });
});

describe('BlockRegistry.deleteSubscription', () => {
  beforeEach(() => {
    mockDbWrite.blockUserSubscription.findUnique.mockReset();
    mockDbWrite.blockUserSubscription.delete.mockReset();
  });

  it('is a no-op when the row does not exist (idempotent)', async () => {
    mockDbWrite.blockUserSubscription.findUnique.mockResolvedValue(null);
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.deleteSubscription({ subscriptionId: 'bus_missing', userId: 1 });
    expect(mockDbWrite.blockUserSubscription.delete).not.toHaveBeenCalled();
  });

  it('refuses to delete a subscription owned by another user', async () => {
    mockDbWrite.blockUserSubscription.findUnique.mockResolvedValue({ userId: 99 });
    const { BlockRegistry } = await import('../block-registry.service');
    await expect(
      BlockRegistry.deleteSubscription({ subscriptionId: 'bus_x', userId: 1 })
    ).rejects.toThrow();
    expect(mockDbWrite.blockUserSubscription.delete).not.toHaveBeenCalled();
  });

  it('deletes the row when the caller owns it', async () => {
    mockDbWrite.blockUserSubscription.findUnique.mockResolvedValue({ userId: 1 });
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.deleteSubscription({ subscriptionId: 'bus_x', userId: 1 });
    expect(mockDbWrite.blockUserSubscription.delete).toHaveBeenCalledWith({
      where: { id: 'bus_x' },
    });
  });
});

describe('BlockRegistry.listAvailable', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockReset();
  });

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

  it('filters on status=approved and orders by install_count desc', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([]);
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listAvailable({ limit: 20 });
    const sql = capturedSql();
    expect(sql).toMatch(/ab\.status\s*=\s*'approved'/);
    expect(sql).toMatch(/ORDER BY install_count DESC/);
  });

  it('returns a nextCursor when the result exceeds limit (limit+1 sentinel)', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([
      { id: 'ab_1', block_id: 'b1', app_id: 'oc', app_name: 'A', manifest: {}, install_count: BigInt(5) },
      { id: 'ab_2', block_id: 'b2', app_id: 'oc', app_name: 'A', manifest: {}, install_count: BigInt(4) },
      { id: 'ab_3', block_id: 'b3', app_id: 'oc', app_name: 'A', manifest: {}, install_count: BigInt(3) },
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const out = await BlockRegistry.listAvailable({ limit: 2 });
    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBe('ab_2');
  });
});
