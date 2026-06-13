import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BlockRegistry.resolveBlockInstance — the centralised lookup that translates
 * a blockInstanceId of any kind (real install `bki_*`/`mbi_*`, platform
 * default `pdb_*`, publisher subscription `bus_pub_*`, viewer subscription
 * `bus_view_*`) into the install-shape struct downstream code (token mint,
 * settings update, workflow submit) consumes.
 *
 * Security-critical: these tests pin the cross-row re-validation that keeps
 * an authenticated iframe from minting a token for a model the resolved
 * source row doesn't actually surface on. Without that re-validation the
 * caller-supplied slotContext could lie about modelId/slotId for any
 * synthetic id and the source row would be silently trusted.
 *
 * Post 2026-05-30 kill_per_model_installs migration:
 *   - per-model installs (mbi_/bki_ ids) resolve via block_user_subscriptions
 *     by the preserved blockInstanceId column
 *   - all four suppression paths look at block_user_subscriptions for the
 *     pinned shape (NOT model_block_installs)
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

/** Subscription shape returned by findUnique for the pinned (bki_*) path. */
function makePinnedSub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: 42,
    scope: 'publisher_all_my_models',
    slotId: 'model.sidebar_top',
    targetModelIds: [100],
    targetModelTypes: [],
    targetBaseModels: [],
    enabled: true,
    settings: { default_checkpoint_version_id: 9 },
    installedByUserId: 42,
    appBlock: APPROVED_BLOCK,
    ...overrides,
  };
}

/** Subscription shape returned by findUnique for the blanket (bus_pub_*) path. */
function makeBlanketPublisherSub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: 42,
    scope: 'publisher_all_my_models',
    slotId: null,
    targetModelIds: [],
    targetModelTypes: [],
    targetBaseModels: [],
    enabled: true,
    settings: { buzz_budget_per_gen: 25 },
    installedByUserId: 42,
    appBlock: APPROVED_BLOCK,
    ...overrides,
  };
}

/** Subscription shape returned by findUnique for the viewer (bus_view_*) path. */
function makeViewerSub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: 7,
    scope: 'viewer_personal',
    slotId: null,
    targetModelIds: [],
    targetModelTypes: [],
    targetBaseModels: [],
    enabled: true,
    settings: {},
    appBlock: APPROVED_BLOCK,
    ...overrides,
  };
}

function resetAll() {
  for (const tbl of Object.values(mockDb)) {
    for (const fn of Object.values(tbl)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
}

describe('BlockRegistry.resolveBlockInstance', () => {
  beforeEach(resetAll);

  describe('bki_* (per-model install — now via block_user_subscriptions)', () => {
    it('resolves a pinned subscription row and matches modelId/slotId', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(makePinnedSub());
      mockDb.model.findUnique.mockResolvedValueOnce({ userId: 42, type: 'LORA' });
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

    it('returns null when caller-supplied modelId does NOT match target_model_ids', async () => {
      // Critical: a stale tab on model 999 trying to mint against a pinned
      // sub for model 100 must not succeed.
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(makePinnedSub());
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bki_x',
        modelId: 999, // not in target_model_ids
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
    });

    it('returns null on disabled or non-approved install', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(
        makePinnedSub({ enabled: false })
      );
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bki_x',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
    });

    it('returns null when the model owner does not match the subscription user', async () => {
      // Defense-in-depth: if the model ownership transferred away from the
      // subscription user since install, the pinned sub no longer mints.
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(makePinnedSub());
      mockDb.model.findUnique.mockResolvedValueOnce({ userId: 99, type: 'LORA' });
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
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(null);
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
      mockDb.blockUserSubscription.findFirst.mockResolvedValueOnce(null); // no pinned-sub suppressor
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

    it('suppression: returns null when a pinned subscription on same (model, slot, app_block) exists', async () => {
      mockDb.platformDefaultBlock.findUnique.mockResolvedValueOnce({
        enabled: true,
        slotId: 'model.sidebar_top',
        targetModelTypes: [],
        appBlock: APPROVED_BLOCK,
      });
      // Pinned sub suppressor present.
      mockDb.blockUserSubscription.findFirst.mockResolvedValueOnce({ id: 'bus_pin' });
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

  describe('bus_pub_* (publisher subscription — blanket-only)', () => {
    it('happy path: resolves when bus.user_id == Model.userId and predicates pass', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(makeBlanketPublisherSub());
      mockDb.model.findUnique.mockResolvedValueOnce({ userId: 42, type: 'LORA' });
      // No pinned-sub suppressor.
      mockDb.blockUserSubscription.findFirst.mockResolvedValueOnce(null);
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
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(makeBlanketPublisherSub());
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

    it('suppression: pinned subscription on same (model, slot, app_block) hides the blanket sub', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(makeBlanketPublisherSub());
      mockDb.model.findUnique.mockResolvedValueOnce({ userId: 42, type: 'LORA' });
      mockDb.blockUserSubscription.findFirst.mockResolvedValueOnce({ id: 'bus_pin' });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_pub_busid',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      });
      expect(r).toBeNull();
    });

    it('returns null when bus_pub_ id resolves to the pinned shape (slot_id set / target_model_ids non-empty)', async () => {
      // Defense-in-depth: the bus_pub_ prefix is for the BLANKET shape
      // only. A pinned sub would have come in as bki_* — if it shows up
      // here it means the client is constructing a bogus id from a row
      // it isn't allowed to see.
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(
        makeBlanketPublisherSub({ slotId: 'model.sidebar_top', targetModelIds: [100] })
      );
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_pub_pinid',
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
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(
        makeBlanketPublisherSub({ appBlock: blockTargetingDifferentSlot })
      );
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
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(
        makeBlanketPublisherSub({ targetBaseModels: ['Flux.1 D'] })
      );
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
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(
        makeBlanketPublisherSub({ enabled: false })
      );
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
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(
        makeBlanketPublisherSub({ appBlock: { ...APPROVED_BLOCK, status: 'pending' } })
      );
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
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(makeViewerSub());
      mockDb.model.findUnique.mockResolvedValueOnce({ userId: 99, type: 'LORA' });
      // No suppressors at any rank.
      // rank-1 + rank-2 both use blockUserSubscription.findFirst (the
      // suppression queries hit the same table in different shapes — pin
      // then blanket).
      mockDb.blockUserSubscription.findFirst
        .mockResolvedValueOnce(null) // rank-1 pinned suppressor
        .mockResolvedValueOnce(null); // rank-2 blanket suppressor
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
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(makeViewerSub());
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

    it('rank-1 suppression: pinned subscription hides the viewer subscription', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(makeViewerSub());
      mockDb.model.findUnique.mockResolvedValueOnce({ userId: 99, type: 'LORA' });
      // First findFirst is the rank-1 pinned suppressor — returns a hit.
      mockDb.blockUserSubscription.findFirst.mockResolvedValueOnce({ id: 'bus_pin' });
      const { BlockRegistry } = await import('../block-registry.service');
      const r = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: 'bus_view_busid',
        modelId: 100,
        slotId: 'model.sidebar_top',
        viewerUserId: 7,
      });
      expect(r).toBeNull();
    });

    it('rank-2 suppression: blanket publisher subscription for the model owner hides viewer', async () => {
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(makeViewerSub());
      mockDb.model.findUnique.mockResolvedValueOnce({ userId: 99, type: 'LORA' });
      mockDb.blockUserSubscription.findFirst
        .mockResolvedValueOnce(null) // rank-1 pinned suppressor: empty
        .mockResolvedValueOnce({ id: 'pubbusid' }); // rank-2 blanket suppressor: hit
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
      mockDb.blockUserSubscription.findUnique.mockResolvedValueOnce(makeViewerSub());
      mockDb.model.findUnique.mockResolvedValueOnce({ userId: 99, type: 'LORA' });
      mockDb.blockUserSubscription.findFirst
        .mockResolvedValueOnce(null) // rank-1
        .mockResolvedValueOnce(null); // rank-2
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
