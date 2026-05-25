import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BlockRegistry.resolveBlockInstance — the centralised lookup that translates
 * a blockInstanceId of any kind (real install `bki_*`, platform default
 * `pdb_*`, publisher subscription `bus_pub_*`, viewer subscription
 * `bus_view_*`) into the install-shape struct downstream code (token mint,
 * settings update, workflow submit) consumes.
 *
 * Security-critical: these tests pin the cross-row re-validation that keeps
 * an authenticated iframe from minting a token for a model the resolved
 * source row doesn't actually surface on. Without that re-validation the
 * caller-supplied slotContext could lie about modelId/slotId for any
 * synthetic id and the source row would be silently trusted.
 */

const { mockDb, mockRedis, mockSysRedis } = vi.hoisted(() => {
  const db = {
    modelBlockInstall: {
      findUnique: vi.fn<(...args: any[]) => Promise<any>>(),
      findFirst: vi.fn<(...args: any[]) => Promise<any>>(),
    },
    platformDefaultBlock: {
      findUnique: vi.fn<(...args: any[]) => Promise<any>>(),
      findFirst: vi.fn<(...args: any[]) => Promise<any>>(),
    },
    blockUserSubscription: {
      findUnique: vi.fn<(...args: any[]) => Promise<any>>(),
      findFirst: vi.fn<(...args: any[]) => Promise<any>>(),
    },
    model: {
      findUnique: vi.fn<(...args: any[]) => Promise<any>>(),
    },
    modelVersion: {
      findFirst: vi.fn<(...args: any[]) => Promise<any>>(),
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

const APPROVED_BLOCK = {
  id: 'ab_test',
  blockId: 'gen-from-model',
  appId: 'app_test',
  status: 'approved',
  manifest: {
    targets: [{ slotId: 'model.sidebar_top' }],
    scopes: ['models:read:self'],
  },
  approvedScopes: ['models:read:self'],
  app: { allowedScopes: 33554431 },
};

function resetAll() {
  for (const tbl of Object.values(mockDb)) {
    for (const fn of Object.values(tbl)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
}

describe('BlockRegistry.resolveBlockInstance', () => {
  beforeEach(resetAll);

  describe('bki_* (per-model install)', () => {
    it('resolves a real install row and matches modelId/slotId', async () => {
      mockDb.modelBlockInstall.findUnique.mockResolvedValueOnce({
        modelId: 100,
        slotId: 'model.sidebar_top',
        enabled: true,
        settings: { default_checkpoint_version_id: 9 },
        installedByUserId: 42,
        appBlock: APPROVED_BLOCK,
      });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bki_real',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: 7,
      });
      expect(r).not.toBeNull();
      expect(r!.source).toBe('install');
      expect(r!.modelId).toBe(100);
      expect(r!.installedByUserId).toBe(42);
      expect(r!.settings).toEqual({ default_checkpoint_version_id: 9 });
      expect(r!.appBlock.blockId).toBe('gen-from-model');
    });

    it('returns null when caller-supplied modelId does NOT match the row', async () => {
      // Critical: a stale tab on model A trying to mint against an install
      // that actually belongs to model B must not succeed.
      mockDb.modelBlockInstall.findUnique.mockResolvedValueOnce({
        modelId: 100,
        slotId: 'model.sidebar_top',
        enabled: true,
        settings: {},
        installedByUserId: 42,
        appBlock: APPROVED_BLOCK,
      });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bki_x',
        modelId: 999, // != row.modelId
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
    });

    it('returns null on disabled or non-approved install', async () => {
      mockDb.modelBlockInstall.findUnique.mockResolvedValueOnce({
        modelId: 100,
        slotId: 'model.sidebar_top',
        enabled: false,
        settings: {},
        installedByUserId: 42,
        appBlock: APPROVED_BLOCK,
      });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bki_x',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
    });

    it('returns null when the install row does not exist', async () => {
      mockDb.modelBlockInstall.findUnique.mockResolvedValueOnce(null);
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bki_missing',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
    });
  });

  describe('pdb_* (platform default)', () => {
    it('resolves when the platform default exists, enabled, slot matches', async () => {
      mockDb.platformDefaultBlock.findUnique.mockResolvedValueOnce({
        enabled: true,
        slotId: 'model.sidebar_top',
        targetModelTypes: [],
        appBlock: APPROVED_BLOCK,
      });
      mockDb.modelBlockInstall.findFirst.mockResolvedValueOnce(null); // no suppressor
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'pdb_ab_test',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).not.toBeNull();
      expect(r!.source).toBe('platform_default');
      expect(r!.installedByUserId).toBeNull();
      expect(r!.settings).toEqual({});
    });

    it('suppression: returns null when a per-model install on same (model, slot, app_block) exists', async () => {
      mockDb.platformDefaultBlock.findUnique.mockResolvedValueOnce({
        enabled: true,
        slotId: 'model.sidebar_top',
        targetModelTypes: [],
        appBlock: APPROVED_BLOCK,
      });
      // suppressor present
      mockDb.modelBlockInstall.findFirst.mockResolvedValueOnce({ blockInstanceId: 'bki_other' });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'pdb_ab_test',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
    });

    it('target_model_types filter excludes mismatched model type', async () => {
      mockDb.platformDefaultBlock.findUnique.mockResolvedValueOnce({
        enabled: true,
        slotId: 'model.sidebar_top',
        targetModelTypes: ['Checkpoint'],
        appBlock: APPROVED_BLOCK,
      });
      mockDb.model.findUnique.mockResolvedValueOnce({ type: 'LORA' });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'pdb_ab_test',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
    });

    it('returns null when slotId does not match', async () => {
      mockDb.platformDefaultBlock.findUnique.mockResolvedValueOnce({
        enabled: true,
        slotId: 'model.below_images',
        targetModelTypes: [],
        appBlock: APPROVED_BLOCK,
      });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'pdb_ab_test',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
    });

    it('returns null when the pdb is disabled', async () => {
      mockDb.platformDefaultBlock.findUnique.mockResolvedValueOnce({
        enabled: false,
        slotId: 'model.sidebar_top',
        targetModelTypes: [],
        appBlock: APPROVED_BLOCK,
      });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'pdb_ab_test',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
    });
  });

  describe('bus_pub_* (publisher subscription)', () => {
    it('happy path: resolves when bus.user_id == Model.userId and predicates pass', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce({
        userId: 42,
        scope: 'publisher_all_my_models',
        enabled: true,
        settings: { buzz_budget_per_gen: 25 },
        targetModelTypes: [],
        targetBaseModels: [],
        appBlock: APPROVED_BLOCK,
      });
      mockDb.model.findUnique.mockResolvedValueOnce({ userId: 42, type: 'LORA' });
      mockDb.modelBlockInstall.findFirst.mockResolvedValueOnce(null); // no suppressor
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_pub_busid',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: 7,
      });
      expect(r).not.toBeNull();
      expect(r!.source).toBe('publisher_subscription');
      expect(r!.installedByUserId).toBe(42); // subscription owner is the "publisher"
      expect(r!.settings).toEqual({ buzz_budget_per_gen: 25 });
    });

    it('returns null when the model is not owned by the subscription user (wrong-model-owner)', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce({
        userId: 42,
        scope: 'publisher_all_my_models',
        enabled: true,
        settings: {},
        targetModelTypes: [],
        targetBaseModels: [],
        appBlock: APPROVED_BLOCK,
      });
      mockDb.model.findUnique.mockResolvedValueOnce({ userId: 99, type: 'LORA' }); // != 42
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_pub_busid',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
    });

    it('suppression: per-model install on same (model, slot, app_block) hides the subscription', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce({
        userId: 42,
        scope: 'publisher_all_my_models',
        enabled: true,
        settings: {},
        targetModelTypes: [],
        targetBaseModels: [],
        appBlock: APPROVED_BLOCK,
      });
      mockDb.model.findUnique.mockResolvedValueOnce({ userId: 42, type: 'LORA' });
      mockDb.modelBlockInstall.findFirst.mockResolvedValueOnce({ blockInstanceId: 'bki_x' });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_pub_busid',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
    });

    it('returns null when manifest does not target the requested slot', async () => {
      const blockTargetingDifferentSlot = {
        ...APPROVED_BLOCK,
        manifest: { ...APPROVED_BLOCK.manifest, targets: [{ slotId: 'model.below_images' }] },
      };
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce({
        userId: 42,
        scope: 'publisher_all_my_models',
        enabled: true,
        settings: {},
        targetModelTypes: [],
        targetBaseModels: [],
        appBlock: blockTargetingDifferentSlot,
      });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_pub_busid',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
    });

    it('target_base_models filter requires a matching version', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce({
        userId: 42,
        scope: 'publisher_all_my_models',
        enabled: true,
        settings: {},
        targetModelTypes: [],
        targetBaseModels: ['Flux.1 D'],
        appBlock: APPROVED_BLOCK,
      });
      mockDb.model.findUnique.mockResolvedValueOnce({ userId: 42, type: 'LORA' });
      mockDb.modelVersion.findFirst.mockResolvedValueOnce(null); // no version matches
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_pub_busid',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
    });

    it('returns null when the subscription is disabled', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce({
        userId: 42,
        scope: 'publisher_all_my_models',
        enabled: false,
        settings: {},
        targetModelTypes: [],
        targetBaseModels: [],
        appBlock: APPROVED_BLOCK,
      });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_pub_busid',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
    });

    it('returns null when the app block is not approved', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce({
        userId: 42,
        scope: 'publisher_all_my_models',
        enabled: true,
        settings: {},
        targetModelTypes: [],
        targetBaseModels: [],
        appBlock: { ...APPROVED_BLOCK, status: 'pending' },
      });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_pub_busid',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
    });
  });

  describe('bus_view_* (viewer subscription)', () => {
    it('happy path: resolves when the viewer == subscription owner', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce({
        userId: 7,
        scope: 'viewer_personal',
        enabled: true,
        settings: {},
        targetModelTypes: [],
        targetBaseModels: [],
        appBlock: APPROVED_BLOCK,
      });
      mockDb.model.findUnique.mockResolvedValueOnce({ userId: 99, type: 'LORA' });
      // No suppressors at any rank.
      mockDb.modelBlockInstall.findFirst.mockResolvedValueOnce(null);
      mockDb.blockUserSubscription.findFirst.mockResolvedValueOnce(null);
      mockDb.platformDefaultBlock.findFirst.mockResolvedValueOnce(null);
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_view_busid',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: 7,
      });
      expect(r).not.toBeNull();
      expect(r!.source).toBe('viewer_subscription');
      expect(r!.installedByUserId).toBe(7);
    });

    it('returns null when the viewer is NOT the subscription owner', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce({
        userId: 7,
        scope: 'viewer_personal',
        enabled: true,
        settings: {},
        targetModelTypes: [],
        targetBaseModels: [],
        appBlock: APPROVED_BLOCK,
      });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_view_busid',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: 999, // != 7
      });
      expect(r).toBeNull();
    });

    it('anon viewer (null userId) always fails for viewer subscriptions', async () => {
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_view_anything',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
      // Crucially we never hit the DB at all for anon viewers on bus_view_*.
      expect(mockDb.blockUserSubscription.findUnique).not.toHaveBeenCalled();
    });

    it('rank-1 suppression: per-model install hides the viewer subscription', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce({
        userId: 7,
        scope: 'viewer_personal',
        enabled: true,
        settings: {},
        targetModelTypes: [],
        targetBaseModels: [],
        appBlock: APPROVED_BLOCK,
      });
      mockDb.model.findUnique.mockResolvedValueOnce({ userId: 99, type: 'LORA' });
      mockDb.modelBlockInstall.findFirst.mockResolvedValueOnce({ blockInstanceId: 'bki_x' });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_view_busid',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: 7,
      });
      expect(r).toBeNull();
    });

    it('rank-2 suppression: publisher subscription for the model owner hides viewer', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce({
        userId: 7,
        scope: 'viewer_personal',
        enabled: true,
        settings: {},
        targetModelTypes: [],
        targetBaseModels: [],
        appBlock: APPROVED_BLOCK,
      });
      mockDb.model.findUnique.mockResolvedValueOnce({ userId: 99, type: 'LORA' });
      mockDb.modelBlockInstall.findFirst.mockResolvedValueOnce(null);
      mockDb.blockUserSubscription.findFirst.mockResolvedValueOnce({ id: 'pubbusid' });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_view_busid',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: 7,
      });
      expect(r).toBeNull();
    });

    it('rank-3 suppression: platform default hides viewer', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce({
        userId: 7,
        scope: 'viewer_personal',
        enabled: true,
        settings: {},
        targetModelTypes: [],
        targetBaseModels: [],
        appBlock: APPROVED_BLOCK,
      });
      mockDb.model.findUnique.mockResolvedValueOnce({ userId: 99, type: 'LORA' });
      mockDb.modelBlockInstall.findFirst.mockResolvedValueOnce(null);
      mockDb.blockUserSubscription.findFirst.mockResolvedValueOnce(null);
      mockDb.platformDefaultBlock.findFirst.mockResolvedValueOnce({ appBlockId: 'ab_test' });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_view_busid',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: 7,
      });
      expect(r).toBeNull();
    });
  });

  describe('malformed / unknown ids', () => {
    it('returns null for an unknown prefix (does not throw)', async () => {
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'garbage_id',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: 7,
      });
      expect(r).toBeNull();
    });

    it('returns null for empty body after prefix (`pdb_` with no id)', async () => {
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'pdb_',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: 7,
      });
      expect(r).toBeNull();
    });

    it('returns null for empty body after `bus_pub_` prefix', async () => {
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_pub_',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: 7,
      });
      expect(r).toBeNull();
    });
  });
});
