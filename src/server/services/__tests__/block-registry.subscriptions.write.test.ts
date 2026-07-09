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
    $queryRaw: vi.fn<(...args: any[]) => Promise<any[]>>(async () => []),
    blockUserSubscription: {
      findMany: vi.fn<(...args: any[]) => Promise<any[]>>(async () => []),
    },
    model: { findMany: vi.fn<(...args: any[]) => Promise<any[]>>(async () => []) },
    appBlockPublishRequest: {
      groupBy: vi.fn<(...args: any[]) => Promise<any[]>>(async () => []),
    },
  };
  const dbWrite = {
    appBlock: { findUnique: vi.fn<(...args: any[]) => Promise<any>>() },
    blockUserSubscription: {
      findFirst: vi.fn<(...args: any[]) => Promise<any>>(),
      create: vi.fn<(...args: any[]) => Promise<any>>(async () => ({})),
      update: vi.fn<(...args: any[]) => Promise<any>>(async () => ({})),
      findUnique: vi.fn<(...args: any[]) => Promise<any>>(),
      delete: vi.fn<(...args: any[]) => Promise<any>>(async () => undefined),
    },
    // A6: upsertSubscription now writes an implicit-consent grant via
    // recordInstallConsent → recordScopeGrant.
    appUserScopeGrant: {
      findUnique: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
      create: vi.fn<(...args: any[]) => Promise<any>>(async () => ({})),
      update: vi.fn<(...args: any[]) => Promise<any>>(async () => ({})),
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
    mockDbRead.model.findMany.mockReset();
    mockDbRead.model.findMany.mockResolvedValue([]);
    mockDbRead.appBlockPublishRequest.groupBy.mockReset();
    mockDbRead.appBlockPublishRequest.groupBy.mockResolvedValue([]);
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
        targetModelIds: [],
        slotId: null,
        pinnedVersion: null,
        blockInstanceId: null,
        settings: { buzz_budget_per_gen: 50 },
        enabled: true,
        createdAt: now,
        updatedAt: now,
        appBlock: {
          blockId: 'generate-from-model',
          appId: 'oc_test',
          manifest: { name: 'Gen' },
          version: '0.1.0',
        },
      },
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const out = await BlockRegistry.listUserSubscriptions(42);
    expect(out).toHaveLength(1);
    expect(out[0].targetModelTypes).toBeNull();
    expect(out[0].targetBaseModels).toEqual(['Flux.1 D']);
    expect(out[0].targetModelIds).toBeNull();
    expect(out[0].slotId).toBeNull();
    expect(out[0].blockId).toBe('generate-from-model');
    expect(out[0].settings).toEqual({ buzz_budget_per_gen: 50 });
    expect(out[0].pinnedModelNames).toBeNull();
    expect(out[0].currentVersion).toBe('0.1.0');
    expect(out[0].availableVersions).toEqual([]);
    const callArgs = mockDbRead.blockUserSubscription.findMany.mock.calls.at(-1)?.[0] as {
      where: { userId: number };
      orderBy: { updatedAt: string };
    };
    expect(callArgs.where.userId).toBe(42);
    expect(callArgs.orderBy.updatedAt).toBe('desc');
  });

  it('hydrates pinnedModelNames + availableVersions for the pinned shape', async () => {
    const now = new Date();
    const approvedAt = new Date(now.getTime() - 86400_000);
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      {
        id: 'bus_pin_1',
        scope: 'publisher_all_my_models',
        appBlockId: 'ab_one',
        targetModelTypes: [],
        targetBaseModels: [],
        targetModelIds: [101, 202],
        slotId: 'model.sidebar_top',
        pinnedVersion: '0.2.0',
        blockInstanceId: 'bki_test',
        settings: {},
        enabled: true,
        createdAt: now,
        updatedAt: now,
        appBlock: {
          blockId: 'generate-from-model',
          appId: 'oc_test',
          manifest: {},
          version: '0.3.0',
        },
      },
    ]);
    mockDbRead.model.findMany.mockResolvedValue([
      { id: 101, name: 'My LoRA' },
      { id: 202, name: 'Other LoRA' },
    ]);
    mockDbRead.appBlockPublishRequest.groupBy.mockResolvedValue([
      { appBlockId: 'ab_one', version: '0.1.0', _max: { reviewedAt: approvedAt } },
      { appBlockId: 'ab_one', version: '0.3.0', _max: { reviewedAt: now } },
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const out = await BlockRegistry.listUserSubscriptions(42);
    expect(out[0].targetModelIds).toEqual([101, 202]);
    expect(out[0].slotId).toBe('model.sidebar_top');
    expect(out[0].pinnedVersion).toBe('0.2.0');
    expect(out[0].blockInstanceId).toBe('bki_test');
    expect(out[0].pinnedModelNames).toEqual({ 101: 'My LoRA', 202: 'Other LoRA' });
    // Versions sort newest-first by reviewedAt.
    expect(out[0].availableVersions.map((v) => v.version)).toEqual(['0.3.0', '0.1.0']);
  });
});

describe('BlockRegistry.upsertSubscription', () => {
  beforeEach(() => {
    mockDbWrite.appBlock.findUnique.mockReset();
    mockDbWrite.blockUserSubscription.findFirst.mockReset();
    mockDbWrite.blockUserSubscription.create.mockReset();
    mockDbWrite.blockUserSubscription.update.mockReset();
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
    expect(mockDbWrite.blockUserSubscription.create).not.toHaveBeenCalled();
    expect(mockDbWrite.blockUserSubscription.update).not.toHaveBeenCalled();
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

  it('creates a blanket subscription row when none exists, with empty target arrays', async () => {
    mockDbWrite.appBlock.findUnique.mockResolvedValue({
      id: 'ab',
      blockId: 'generate-from-model',
      appId: 'a',
      status: 'approved',
      manifest: {},
      version: '0.1.0',
    });
    mockDbWrite.blockUserSubscription.findFirst.mockResolvedValue(null);
    const updatedAt = new Date();
    mockDbWrite.blockUserSubscription.create.mockResolvedValue({
      id: 'bus_new',
      scope: 'publisher_all_my_models',
      appBlockId: 'ab',
      targetModelTypes: [],
      targetBaseModels: [],
      targetModelIds: [],
      slotId: null,
      pinnedVersion: null,
      blockInstanceId: null,
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
    expect(out.targetModelIds).toBeNull();
    expect(out.slotId).toBeNull();
    // findFirst is the blanket-row lookup: scope + slot=NULL + empty target_model_ids.
    const findArgs = mockDbWrite.blockUserSubscription.findFirst.mock.calls.at(-1)?.[0] as {
      where: { userId: number; scope: string; slotId: null };
    };
    expect(findArgs.where.userId).toBe(7);
    expect(findArgs.where.scope).toBe('publisher_all_my_models');
    expect(findArgs.where.slotId).toBeNull();
    const createArgs = mockDbWrite.blockUserSubscription.create.mock.calls.at(-1)?.[0] as {
      data: {
        targetModelTypes: string[];
        targetBaseModels: string[];
        targetModelIds: number[];
        slotId: string | null;
      };
    };
    expect(createArgs.data.targetModelTypes).toEqual([]);
    expect(createArgs.data.targetBaseModels).toEqual([]);
    expect(createArgs.data.targetModelIds).toEqual([]);
    expect(createArgs.data.slotId).toBeNull();
  });

  it('updates an existing blanket row in place when one is found', async () => {
    mockDbWrite.appBlock.findUnique.mockResolvedValue({
      id: 'ab',
      blockId: 'g',
      appId: 'a',
      status: 'approved',
      manifest: {},
      version: '0.1.0',
    });
    mockDbWrite.blockUserSubscription.findFirst.mockResolvedValue({ id: 'bus_existing' });
    const updatedAt = new Date();
    mockDbWrite.blockUserSubscription.update.mockResolvedValue({
      id: 'bus_existing',
      scope: 'publisher_all_my_models',
      appBlockId: 'ab',
      targetModelTypes: [],
      targetBaseModels: [],
      targetModelIds: [],
      slotId: null,
      pinnedVersion: null,
      blockInstanceId: null,
      settings: { a: 1 },
      enabled: false,
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
      settings: { a: 1 },
      enabled: false,
    });
    expect(out.enabled).toBe(false);
    expect(mockDbWrite.blockUserSubscription.create).not.toHaveBeenCalled();
    expect(mockDbWrite.blockUserSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'bus_existing' } })
    );
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
    // E3: listAvailable now calls `$queryRaw(Prisma.sql`…`)` — a single Prisma.Sql
    // object carrying the assembled `.sql` string (it was a tagged template before,
    // which this helper reconstructed). Handle both forms.
    const first = lastCall[0];
    if (first && typeof first === 'object' && typeof (first as { sql?: unknown }).sql === 'string') {
      return (first as { sql: string }).sql;
    }
    const strings = first as unknown as TemplateStringsArray;
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
    // Pass sort explicitly — the schema default ('popular') is applied by the
    // router's zod parse, not when the service is called directly (an undefined
    // sort falls through to the name/ASC branch).
    await BlockRegistry.listAvailable({ limit: 20, sort: 'popular' });
    const sql = capturedSql();
    expect(sql).toMatch(/ab\.status\s*=\s*'approved'/);
    // E3: default sort `popular` now orders by the projected `sort_key` (the
    // zero-padded install count) DESC, not a literal `install_count` column.
    expect(sql).toMatch(/ORDER BY\s+sort_key\s+DESC/i);
  });

  it('returns a nextCursor when the result exceeds limit (limit+1 sentinel)', async () => {
    // E3 rows carry the projected `sort_key` (the cursor encodes it) plus the
    // `category`/`approved_scopes` columns the projection reads.
    mockDbRead.$queryRaw.mockResolvedValue([
      { id: 'ab_1', block_id: 'b1', app_id: 'oc', app_name: 'A', manifest: {}, install_count: BigInt(5), category: null, approved_scopes: [], sort_key: '00000000000000000005' },
      { id: 'ab_2', block_id: 'b2', app_id: 'oc', app_name: 'A', manifest: {}, install_count: BigInt(4), category: null, approved_scopes: [], sort_key: '00000000000000000004' },
      { id: 'ab_3', block_id: 'b3', app_id: 'oc', app_name: 'A', manifest: {}, install_count: BigInt(3), category: null, approved_scopes: [], sort_key: '00000000000000000003' },
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const out = await BlockRegistry.listAvailable({ limit: 2 });
    expect(out.items).toHaveLength(2);
    // E3: nextCursor is now an opaque base64url keyset cursor of the last
    // returned row (ab_2) — `${sort_key}\x1f${id}` — not the bare id.
    expect(out.nextCursor).toBeDefined();
    const [sortKey, id] = Buffer.from(out.nextCursor as string, 'base64url')
      .toString('utf8')
      .split('\x1f');
    expect(id).toBe('ab_2');
    expect(sortKey).toBe('00000000000000000004');
  });
});
