import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A6 (audit HIGH / design-gaps C2) — pinned-version manifest/scope resolution.
 *
 * When a subscription pins a version, resolveBlockInstance MUST return THAT
 * version's manifest + approved-scope set (loaded from
 * app_block_publish_requests), NOT the live AppBlock row. Before A6 the
 * resolver always returned the live row, so a v2 approve that added a scope
 * silently escalated every pinned install on the next render.
 */

const { mockDb, mockRedis, mockSysRedis } = vi.hoisted(() => {
  const db = {
    platformDefaultBlock: {
      findUnique: vi.fn<(...args: any[]) => Promise<any>>(),
      findFirst: vi.fn<(...args: any[]) => Promise<any>>(),
    },
    blockUserSubscription: {
      findUnique: vi.fn<(...args: any[]) => Promise<any>>(),
      findFirst: vi.fn<(...args: any[]) => Promise<any>>(),
    },
    appBlockPublishRequest: {
      findFirst: vi.fn<(...args: any[]) => Promise<any>>(),
    },
    model: {
      findUnique: vi.fn<(...args: any[]) => Promise<any>>(),
    },
    modelVersion: {
      findFirst: vi.fn<(...args: any[]) => Promise<any>>(),
    },
    appBlock: {
      findUnique: vi.fn<(...args: any[]) => Promise<any>>(),
    },
  };
  const redis = {
    packed: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
    scanIterator: async function* () {},
  };
  const sysRedis = { sMembers: vi.fn(async () => []) };
  return { mockDb: db, mockRedis: redis, mockSysRedis: sysRedis };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  sysRedis: mockSysRedis,
  REDIS_KEYS: { BLOCKS: { REGISTRY: 'r', TOKEN_RATE_LIMIT: 'rl', REVOKED_INSTANCE: 'rev' } },
  REDIS_SYS_KEYS: { BLOCKS: { EMERGENCY_KILL_LIST: 'kill' } },
}));

// Live (v2) AppBlock row — has scope A + scope B.
const LIVE_BLOCK = {
  id: 'ab_test',
  blockId: 'gen-from-model',
  appId: 'app_test',
  status: 'approved',
  manifest: {
    targets: [{ slotId: 'model.sidebar_top' }],
    scopes: ['models:read:self', 'ai:write:budgeted'],
  },
  approvedScopes: ['models:read:self', 'ai:write:budgeted'],
  app: { allowedScopes: 33554431 },
};

// v1 publish-request manifest — only scope A.
const V1_MANIFEST = {
  targets: [{ slotId: 'model.sidebar_top' }],
  scopes: ['models:read:self'],
};

function makePinnedSub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: 42,
    scope: 'publisher_all_my_models',
    slotId: 'model.sidebar_top',
    targetModelIds: [100],
    targetModelTypes: [],
    targetBaseModels: [],
    enabled: true,
    settings: {},
    installedByUserId: 42,
    pinnedVersion: null,
    appBlock: LIVE_BLOCK,
    ...overrides,
  };
}

function resetAll() {
  for (const tbl of Object.values(mockDb)) {
    for (const fn of Object.values(tbl)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
}

describe('resolveBlockInstance — pinned-version resolution (A6)', () => {
  beforeEach(resetAll);

  it('unpinned install returns the LIVE manifest + approved scopes', async () => {
    mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(
      makePinnedSub({ pinnedVersion: null })
    );
    mockDb.model.findUnique.mockResolvedValueOnce({ userId: 42, type: 'LORA' });
    const { BlockRegistry } = await import('../block-registry.service');
    const r = await BlockRegistry.resolveBlockInstance({
      blockInstanceId: 'bki_real',
      modelId: 100,
      slotId: 'model.sidebar_top',
      viewerUserId: 7,
    });
    expect(r).not.toBeNull();
    expect(r!.appBlock.approvedScopes).toEqual(['models:read:self', 'ai:write:budgeted']);
    // The publish-request table is never consulted for an unpinned install.
    expect(mockDb.appBlockPublishRequest.findFirst).not.toHaveBeenCalled();
  });

  it('pinned install resolves the pinned version manifest/scopes (NOT the live row)', async () => {
    mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(
      makePinnedSub({ pinnedVersion: '1.0.0' })
    );
    mockDb.model.findUnique.mockResolvedValueOnce({ userId: 42, type: 'LORA' });
    mockDb.appBlockPublishRequest.findFirst.mockResolvedValueOnce({ manifest: V1_MANIFEST });
    const { BlockRegistry } = await import('../block-registry.service');
    const r = await BlockRegistry.resolveBlockInstance({
      blockInstanceId: 'bki_real',
      modelId: 100,
      slotId: 'model.sidebar_top',
      viewerUserId: 7,
    });
    expect(r).not.toBeNull();
    // Pinned to v1 → only scope A, even though the live row carries A + B.
    expect(r!.appBlock.approvedScopes).toEqual(['models:read:self']);
    expect(r!.appBlock.manifest).toEqual(V1_MANIFEST);
    // The pinned lookup was keyed on the version + approved status.
    const arg = mockDb.appBlockPublishRequest.findFirst.mock.calls[0][0];
    expect(arg.where.version).toBe('1.0.0');
    expect(arg.where.status).toBe('approved');
    expect(arg.where.appBlockId).toBe('ab_test');
  });

  it('pinned version with no approved publish request FALLS BACK to the live row', async () => {
    mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(
      makePinnedSub({ pinnedVersion: '9.9.9' })
    );
    mockDb.model.findUnique.mockResolvedValueOnce({ userId: 42, type: 'LORA' });
    mockDb.appBlockPublishRequest.findFirst.mockResolvedValueOnce(null); // withdrawn/rejected
    const { BlockRegistry } = await import('../block-registry.service');
    const r = await BlockRegistry.resolveBlockInstance({
      blockInstanceId: 'bki_real',
      modelId: 100,
      slotId: 'model.sidebar_top',
      viewerUserId: 7,
    });
    expect(r).not.toBeNull();
    // Fail-safe: a missing pinned manifest shouldn't empty the scope set; the
    // mint-time grant gate is the authoritative ceiling.
    expect(r!.appBlock.approvedScopes).toEqual(['models:read:self', 'ai:write:budgeted']);
  });

  it('applyPinnedVersion is a no-op when pinnedVersion is null', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const live = { manifest: { scopes: ['models:read:self'] }, approvedScopes: ['models:read:self'] };
    const out = await BlockRegistry.applyPinnedVersion(live, 'ab_test', null, mockDb as never);
    expect(out).toBe(live);
    expect(mockDb.appBlockPublishRequest.findFirst).not.toHaveBeenCalled();
  });
});
