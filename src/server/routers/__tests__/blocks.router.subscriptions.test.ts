import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * Coverage for the four user-subscription procedures on blocksRouter:
 *   - listMySubscriptions (guarded: auth required)
 *   - listAvailable (public)
 *   - upsertSubscription (guarded: per-block-id settings validation,
 *     status='approved' gate)
 *   - deleteSubscription (guarded: owner-only via service layer)
 *
 * The service layer (BlockRegistry) is mocked at the module boundary so
 * we exercise only the router's auth gates, input shape, and forwarded
 * arguments.
 */

const {
  mockListUserSubscriptions,
  mockListAvailable,
  mockUpsertSubscription,
  mockDeleteSubscription,
  mockInstallOnModel,
  mockUpdateSettings,
  mockToggleEnabled,
  mockIsAppBlocksEnabled,
  mockDbReadAppBlockFindUnique,
  mockDbWriteModelFindUnique,
  mockDbWriteSubscriptionFindUnique,
  mockGetUserBuzzAccounts,
} = vi.hoisted(() => ({
  mockListUserSubscriptions: vi.fn(),
  mockListAvailable: vi.fn(),
  mockUpsertSubscription: vi.fn(),
  mockDeleteSubscription: vi.fn(async () => undefined),
  mockInstallOnModel: vi.fn(),
  mockUpdateSettings: vi.fn(async () => undefined),
  mockToggleEnabled: vi.fn(async () => undefined),
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  mockDbReadAppBlockFindUnique: vi.fn(),
  mockDbWriteModelFindUnique: vi.fn(),
  mockDbWriteSubscriptionFindUnique: vi.fn(),
  mockGetUserBuzzAccounts: vi.fn(async () => ({ yellow: 0, blue: 0, green: 0 })),
}));

vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    installOnModel: mockInstallOnModel,
    updateSettings: mockUpdateSettings,
    toggleEnabled: mockToggleEnabled,
    uninstallFromModel: vi.fn(),
    listUserSubscriptions: mockListUserSubscriptions,
    listAvailable: mockListAvailable,
    upsertSubscription: mockUpsertSubscription,
    deleteSubscription: mockDeleteSubscription,
    upsertUserSettings: vi.fn(),
    getEffectiveCheckpoint: vi.fn(),
  },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/db/client', () => ({
  dbRead: { appBlock: { findUnique: mockDbReadAppBlockFindUnique } },
  dbWrite: {
    modelBlockInstall: { findUnique: vi.fn() },
    model: { findUnique: mockDbWriteModelFindUnique },
    blockUserSubscription: { findUnique: mockDbWriteSubscriptionFindUnique },
  },
}));
// Mock the heavy peer modules the router imports so the import graph
// stays cheap and we don't accidentally hit live deps.
// blocks.router transitively pulls in many redis-cache modules (resource-data.redis,
// caches.ts, ...) that each read `REDIS_KEYS.<GROUP>.<KEY>` AT IMPORT TIME. The
// real keys live in redis/client (which connects on import, so we can't
// importActual it). A hand-trimmed REDIS_KEYS is whack-a-mole: it flakily threw on
// whichever key the current load order happened to reach first (RESOURCE_DATA, then
// CACHES.TAG_IDS_FOR_IMAGES, ...). `completeKeys` wraps the few values the tests
// assert on with an auto-vivifying Proxy so ANY other key resolves to a
// deterministic placeholder string instead of `undefined.X` — ending the flake.
const { completeKeys } = vi.hoisted(() => {
  const group = (explicit: Record<string, string>, name: string): Record<string, string> =>
    new Proxy(explicit, {
      get: (t, k) => (k in t ? (t as any)[k] : typeof k === 'string' ? `mock:${name}:${k}` : (t as any)[k]),
    });
  const completeKeys = (explicit: Record<string, Record<string, string>>) =>
    new Proxy(explicit, {
      get: (t, g) => (g in t ? group((t as any)[g], g as string) : typeof g === 'string' ? group({}, g) : (t as any)[g]),
    });
  return { completeKeys };
});

vi.mock('~/server/redis/client', () => ({
  redis: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
  REDIS_KEYS: completeKeys({ BLOCKS: {} }),
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: vi.fn(),
  parseSubjectUserId: vi.fn(),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/textToImage/textToImage', () => ({
  createTextToImageStep: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(),
}));
vi.mock('~/server/services/user.service', () => ({ getUserById: vi.fn() }));
// blocks.router imports getUserBuzzAccounts from buzz.service, which transitively
// pulls in ~/server/redis/caches → orchestrator/models → resource-data.redis.
// That last module reads `REDIS_KEYS.GENERATION.RESOURCE_DATA` at import time,
// which throws under the trimmed redis-client mock above (no GENERATION key).
// Mocking buzz.service at the boundary cuts that import chain — same approach the
// sibling blocks.router.workflow.test.ts uses — so the suite can load.
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: mockGetUserBuzzAccounts,
}));
// blocks.router imports `rateLimit` from middleware.trpc, which transitively
// pulls in user-preferences.service → caches.ts → tag.selector (a top-level
// `Prisma.validator(...)` call). In a fresh worktree the generated Prisma client
// can't be produced (NixOS engine fetch), so evaluating that chain throws at
// import time. Mock middleware.trpc with a pass-through `rateLimit` middleware
// (built from the real, lightweight `middleware` factory) to cut the chain —
// rate-limiting isn't under test here. (Same shim the sibling
// blocks.router.getInstallConfig.test.ts / flag-gate.test.ts use.)
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return {
    rateLimit: () => middleware(({ next }) => next()),
  };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function authedCtx(userId: number, isModerator = true) {
  return {
    acceptableOrigin: true,
    // Phase 2: the management procedures are now `moderatorProcedure`, so the
    // happy path needs a moderator user. onboarding=0x1F is retained from the
    // pre-Phase-2 guardedProcedure era (harmless — isMod doesn't require it).
    user: { id: userId, isModerator, onboarding: 0x1f } as never,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: false, isBlue: false, isGreen: false, isGreenSession: false } as never,
    track: undefined,
  };
}

function anonCtx() {
  return {
    acceptableOrigin: true,
    user: undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: false, isBlue: false, isGreen: false, isGreenSession: false } as never,
    track: undefined,
  };
}

beforeEach(() => {
  mockListUserSubscriptions.mockReset();
  mockListAvailable.mockReset();
  mockUpsertSubscription.mockReset();
  mockDeleteSubscription.mockReset();
  mockInstallOnModel.mockReset();
  mockUpdateSettings.mockReset();
  mockToggleEnabled.mockReset();
  mockDbReadAppBlockFindUnique.mockReset();
  mockDbWriteModelFindUnique.mockReset();
  mockDbWriteSubscriptionFindUnique.mockReset();
  mockIsAppBlocksEnabled.mockReset();
  mockIsAppBlocksEnabled.mockImplementation(async () => true);
});

describe('blocks.listMySubscriptions (guarded)', () => {
  it('forwards the authed user id to the service', async () => {
    mockListUserSubscriptions.mockResolvedValue([]);
    const caller = blocksRouter.createCaller(authedCtx(42) as never);
    await caller.listMySubscriptions();
    expect(mockListUserSubscriptions).toHaveBeenCalledWith(42);
  });

  it('rejects anon viewers with UNAUTHORIZED', async () => {
    const caller = blocksRouter.createCaller(anonCtx() as never);
    await expect(caller.listMySubscriptions()).rejects.toBeInstanceOf(TRPCError);
    expect(mockListUserSubscriptions).not.toHaveBeenCalled();
  });

  // GA-relax (gotcha #66): the manage-page reflection queries are now
  // protectedProcedure (not moderatorProcedure) — a logged-in non-mod reads
  // their OWN subscriptions, since /apps/installed is reachable by any user the
  // per-user appBlocks flag admits. Scoped to ctx.user.id, so no cross-user read.
  it('allows a non-mod authed viewer — returns their own subscriptions', async () => {
    mockListUserSubscriptions.mockResolvedValue([]);
    const caller = blocksRouter.createCaller(authedCtx(7, false) as never);
    await caller.listMySubscriptions();
    expect(mockListUserSubscriptions).toHaveBeenCalledWith(7);
  });

  it('returns an empty list when the appBlocks flag is off (fail-soft on query)', async () => {
    mockIsAppBlocksEnabled.mockImplementation(async () => false);
    const caller = blocksRouter.createCaller(authedCtx(42) as never);
    const out = await caller.listMySubscriptions();
    expect(out).toEqual([]);
    expect(mockListUserSubscriptions).not.toHaveBeenCalled();
  });
});

describe('blocks.listAvailable (public)', () => {
  it('returns empty when the appBlocks flag is off', async () => {
    mockIsAppBlocksEnabled.mockImplementation(async () => false);
    const caller = blocksRouter.createCaller(anonCtx() as never);
    const out = await caller.listAvailable({ limit: 20 });
    expect(out).toEqual({ items: [], nextCursor: undefined });
    expect(mockListAvailable).not.toHaveBeenCalled();
  });

  it('forwards query/slot/limit input to the service (moderator caller)', async () => {
    mockListAvailable.mockResolvedValue({ items: [], nextCursor: undefined });
    // Phase 2: marketplace listing is moderator-only — a mod caller reaches
    // the service.
    const caller = blocksRouter.createCaller(authedCtx(42) as never);
    await caller.listAvailable({
      query: 'generate',
      slotId: 'model.sidebar_top',
      limit: 5,
    });
    expect(mockListAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'generate', slotId: 'model.sidebar_top', limit: 5 })
    );
  });

  it('returns empty for a non-mod caller (Phase 2 internal-only gate)', async () => {
    // The gate IS the mod-segmented `app-blocks-enabled` flag (no separate
    // isModerator belt by design), so a non-mod caller sees it OFF -> gated.
    // Simulate that here (mirrors the anon flag-off sibling above); without it
    // the default mock returns the flag ON and the caller wrongly reaches the
    // service.
    mockIsAppBlocksEnabled.mockImplementation(async () => false);
    const caller = blocksRouter.createCaller(authedCtx(42, false) as never);
    const out = await caller.listAvailable({ limit: 20 });
    expect(out).toEqual({ items: [], nextCursor: undefined });
    expect(mockListAvailable).not.toHaveBeenCalled();
  });

  it('returns empty for an anon caller (Phase 2 internal-only gate)', async () => {
    // The mod-segmented flag is OFF for an anon caller -> gated to empty.
    mockIsAppBlocksEnabled.mockImplementation(async () => false);
    const caller = blocksRouter.createCaller(anonCtx() as never);
    const out = await caller.listAvailable({ limit: 20 });
    expect(out).toEqual({ items: [], nextCursor: undefined });
    expect(mockListAvailable).not.toHaveBeenCalled();
  });
});

describe('blocks.upsertSubscription (guarded)', () => {
  it('rejects anon viewers with UNAUTHORIZED', async () => {
    const caller = blocksRouter.createCaller(anonCtx() as never);
    await expect(
      caller.upsertSubscription({
        appBlockId: 'ab_x',
        scope: 'viewer_personal',
        targetModelTypes: null,
        targetBaseModels: null,
        settings: {},
      })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockUpsertSubscription).not.toHaveBeenCalled();
  });

  it('rejects when the app block is not found', async () => {
    mockDbReadAppBlockFindUnique.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(authedCtx(42) as never);
    await expect(
      caller.upsertSubscription({
        appBlockId: 'ab_missing',
        scope: 'viewer_personal',
        targetModelTypes: null,
        targetBaseModels: null,
        settings: {},
      })
    ).rejects.toThrow();
    expect(mockUpsertSubscription).not.toHaveBeenCalled();
  });

  it('rejects when the app block is not approved', async () => {
    mockDbReadAppBlockFindUnique.mockResolvedValue({ blockId: 'g', status: 'pending' });
    const caller = blocksRouter.createCaller(authedCtx(42) as never);
    await expect(
      caller.upsertSubscription({
        appBlockId: 'ab_x',
        scope: 'viewer_personal',
        targetModelTypes: null,
        targetBaseModels: null,
        settings: {},
      })
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it('passes manifest-validated settings to the service (publisher-scoped field)', async () => {
    // W3 v0: settings validation is manifest-driven (validateBlockSettings),
    // not a hardcoded per-blockId map. The app must declare the field — here a
    // publisher-scoped number with a [0,1000] range — for it to survive into the
    // forwarded payload. A publisher_* scope writes the `publisher` side, so the
    // field's scope must be `publisher`.
    mockDbReadAppBlockFindUnique.mockResolvedValue({
      blockId: 'generate-from-model',
      status: 'approved',
      approvedScopes: ['ai:write:budgeted'],
      manifest: {
        settings: {
          buzz_budget_per_gen: {
            type: 'number',
            scope: 'publisher',
            label: 'Buzz budget per generation',
            description: 'Max Buzz spent per generation',
            min: 0,
            max: 1000,
          },
        },
      },
    });
    mockUpsertSubscription.mockResolvedValue({ id: 'bus_new' });
    const caller = blocksRouter.createCaller(authedCtx(42) as never);
    await caller.upsertSubscription({
      appBlockId: 'ab_x',
      scope: 'publisher_all_my_models',
      targetModelTypes: ['LORA'],
      targetBaseModels: null,
      settings: { buzz_budget_per_gen: 50 },
    });
    expect(mockUpsertSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        appBlockId: 'ab_x',
        scope: 'publisher_all_my_models',
        targetModelTypes: ['LORA'],
        targetBaseModels: null,
        settings: { buzz_budget_per_gen: 50 },
        enabled: true,
      })
    );
  });

  it('rejects settings that violate the manifest field range (out-of-range buzz budget)', async () => {
    // viewer_personal writes the `viewer` side, so the manifest field must be
    // viewer-scoped to apply. 99_999 exceeds the declared max → BAD_REQUEST.
    mockDbReadAppBlockFindUnique.mockResolvedValue({
      blockId: 'generate-from-model',
      status: 'approved',
      approvedScopes: ['ai:write:budgeted'],
      manifest: {
        settings: {
          buzz_budget_per_gen: {
            type: 'number',
            scope: 'viewer',
            label: 'Buzz budget per generation',
            description: 'Max Buzz spent per generation',
            min: 0,
            max: 1000,
          },
        },
      },
    });
    const caller = blocksRouter.createCaller(authedCtx(42) as never);
    await expect(
      caller.upsertSubscription({
        appBlockId: 'ab_x',
        scope: 'viewer_personal',
        targetModelTypes: null,
        targetBaseModels: null,
        settings: { buzz_budget_per_gen: 99_999 },
      })
    ).rejects.toThrow();
    expect(mockUpsertSubscription).not.toHaveBeenCalled();
  });
});

describe('blocks.deleteSubscription (guarded)', () => {
  it('rejects anon viewers with UNAUTHORIZED', async () => {
    const caller = blocksRouter.createCaller(anonCtx() as never);
    await expect(caller.deleteSubscription({ subscriptionId: 'bus_x' })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockDeleteSubscription).not.toHaveBeenCalled();
  });

  it('forwards subscriptionId + userId to the service', async () => {
    const caller = blocksRouter.createCaller(authedCtx(42) as never);
    const out = await caller.deleteSubscription({ subscriptionId: 'bus_x' });
    expect(out).toEqual({ ok: true });
    expect(mockDeleteSubscription).toHaveBeenCalledWith({
      subscriptionId: 'bus_x',
      userId: 42,
    });
  });
});

/**
 * Layer 1 (App Blocks launch gate-lift) — the six own-data INSTALL procedures
 * (installOnModel, updateSettings, toggleEnabled, getInstallConfig,
 * upsertSubscription, deleteSubscription) were widened
 * `moderatorProcedure → protectedProcedure`, keeping `.use(enforceAppBlocksFlag)`.
 *
 * The change is INERT until the Flipt segment widen because the flag stays
 * mod-segmented: a non-mod sees the flag OFF → `enforceAppBlocksFlag` throws
 * UNAUTHORIZED before the body. Once the segment widens (flag ON for a non-mod),
 * the procedure is OWNER-SCOPED — a non-mod OWNER can act; a non-mod NON-owner
 * is rejected; per-user writes stamp `ctx.user.id` (never input).
 *
 * upsertSubscription/deleteSubscription/installOnModel were previously asserted
 * as FORBIDDEN-for-non-mod here (the old Phase-2 mod gate). That belt is gone by
 * design for these own-data procs; the coverage now lives in the
 * 'Layer 1 — install procs widened to protectedProcedure' describe below. The
 * procedures kept in THIS block (mod-review queue + revenue/apps developer reads)
 * remain mod-gated.
 */
describe('Phase 2 — mod-only procedures reject non-mod verified users (FORBIDDEN)', () => {
  function nonMod() {
    return blocksRouter.createCaller(authedCtx(42, false) as never);
  }

  it('listPendingRequests (mod queue) → FORBIDDEN', async () => {
    await expect(nonMod().listPendingRequests({ limit: 20 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('approveRequest → FORBIDDEN', async () => {
    await expect(
      nonMod().approveRequest({ publishRequestId: 'pubreq_x' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('getMyRevenue → FORBIDDEN', async () => {
    await expect(nonMod().getMyRevenue({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('getMyApps → FORBIDDEN', async () => {
    await expect(nonMod().getMyApps()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

/**
 * Layer 1 (App Blocks launch gate-lift) — the six own-data INSTALL procedures
 * were widened `moderatorProcedure → protectedProcedure` while KEEPING
 * `.use(enforceAppBlocksFlag)`. For each we assert the three invariants that make
 * the swap safe + provably inert:
 *
 *   (a) non-mod OWNER + flag ON  → succeeds (owner-scoped, not mod-scoped);
 *   (b) non-mod NON-owner + flag ON → authorization error (owner check holds);
 *   (c) flag OFF → blocked (UNAUTHORIZED on mutations / empty-soft on the query),
 *       which is the LIVE state for every non-mod today (mod-segmented flag) —
 *       hence the change is inert until the Flipt segment widen.
 *
 * `fakePerUserFlag` mirrors the live mod-segmented `app-blocks-enabled` rule
 * (ON iff the caller is a moderator) for the (c) cases; the (a)/(b) cases force
 * the flag ON to model the post-widen world.
 */
function fakePerUserFlag(opts?: { user?: { isModerator?: boolean } }) {
  return Promise.resolve(!!opts?.user?.isModerator);
}

describe('Layer 1 — install procs widened to protectedProcedure (owner-scoped, inert until flip)', () => {
  const OWNER_ID = 100;
  const OTHER_ID = 200;

  describe('installOnModel', () => {
    const input = { modelId: 7, appBlockId: 'ab_x', slotId: 'model.sidebar_top' as const };

    it('(a) non-mod OWNER + flag ON → installs (assertCanManageBlocks owner path)', async () => {
      mockDbWriteModelFindUnique.mockResolvedValue({ userId: OWNER_ID });
      mockInstallOnModel.mockResolvedValue({ id: 'install_1' });
      const caller = blocksRouter.createCaller(authedCtx(OWNER_ID, false) as never);
      await caller.installOnModel(input);
      expect(mockInstallOnModel).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: 7, appBlockId: 'ab_x', installedByUserId: OWNER_ID })
      );
    });

    it('(b) non-mod NON-owner + flag ON → UNAUTHORIZED, never installs', async () => {
      mockDbWriteModelFindUnique.mockResolvedValue({ userId: OWNER_ID });
      const caller = blocksRouter.createCaller(authedCtx(OTHER_ID, false) as never);
      await expect(caller.installOnModel(input)).rejects.toBeInstanceOf(TRPCError);
      expect(mockInstallOnModel).not.toHaveBeenCalled();
    });

    it('(c) flag OFF (live for a non-mod) → UNAUTHORIZED before the body, never installs', async () => {
      mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
      const caller = blocksRouter.createCaller(authedCtx(OWNER_ID, false) as never);
      await expect(caller.installOnModel(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(mockDbWriteModelFindUnique).not.toHaveBeenCalled();
      expect(mockInstallOnModel).not.toHaveBeenCalled();
    });
  });

  describe('updateSettings', () => {
    const input = { blockInstanceId: 'bus_pinned', settings: { foo: 'bar' } };

    it('(a) non-mod OWNER + flag ON → updates (resolves model → owner check passes)', async () => {
      mockDbWriteSubscriptionFindUnique.mockResolvedValue({ targetModelIds: [7] });
      mockDbWriteModelFindUnique.mockResolvedValue({ userId: OWNER_ID });
      const caller = blocksRouter.createCaller(authedCtx(OWNER_ID, false) as never);
      const out = await caller.updateSettings(input);
      expect(out).toEqual({ ok: true });
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ blockInstanceId: 'bus_pinned', modelId: 7 })
      );
    });

    it('(b) non-mod NON-owner + flag ON → UNAUTHORIZED, never updates', async () => {
      mockDbWriteSubscriptionFindUnique.mockResolvedValue({ targetModelIds: [7] });
      mockDbWriteModelFindUnique.mockResolvedValue({ userId: OWNER_ID });
      const caller = blocksRouter.createCaller(authedCtx(OTHER_ID, false) as never);
      await expect(caller.updateSettings(input)).rejects.toBeInstanceOf(TRPCError);
      expect(mockUpdateSettings).not.toHaveBeenCalled();
    });

    it('(c) flag OFF (live for a non-mod) → UNAUTHORIZED before the body', async () => {
      mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
      const caller = blocksRouter.createCaller(authedCtx(OWNER_ID, false) as never);
      await expect(caller.updateSettings(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(mockDbWriteSubscriptionFindUnique).not.toHaveBeenCalled();
      expect(mockUpdateSettings).not.toHaveBeenCalled();
    });
  });

  describe('toggleEnabled', () => {
    const input = { blockInstanceId: 'bus_pinned', enabled: false };

    it('(a) non-mod OWNER + flag ON → toggles (owner check on resolved model)', async () => {
      mockDbWriteSubscriptionFindUnique.mockResolvedValue({
        appBlockId: 'ab_x',
        slotId: 'model.sidebar_top',
        targetModelIds: [7],
      });
      mockDbWriteModelFindUnique.mockResolvedValue({ userId: OWNER_ID });
      const caller = blocksRouter.createCaller(authedCtx(OWNER_ID, false) as never);
      const out = await caller.toggleEnabled(input);
      expect(out).toEqual({ ok: true });
      expect(mockToggleEnabled).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: 7, appBlockId: 'ab_x', enabled: false })
      );
    });

    it('(b) non-mod NON-owner + flag ON → UNAUTHORIZED before mutating', async () => {
      mockDbWriteSubscriptionFindUnique.mockResolvedValue({
        appBlockId: 'ab_x',
        slotId: 'model.sidebar_top',
        targetModelIds: [7],
      });
      mockDbWriteModelFindUnique.mockResolvedValue({ userId: OWNER_ID });
      const caller = blocksRouter.createCaller(authedCtx(OTHER_ID, false) as never);
      await expect(caller.toggleEnabled(input)).rejects.toBeInstanceOf(TRPCError);
      expect(mockToggleEnabled).not.toHaveBeenCalled();
    });

    it('(c) flag OFF (live for a non-mod) → UNAUTHORIZED before the body', async () => {
      mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
      const caller = blocksRouter.createCaller(authedCtx(OWNER_ID, false) as never);
      await expect(caller.toggleEnabled(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(mockDbWriteSubscriptionFindUnique).not.toHaveBeenCalled();
      expect(mockToggleEnabled).not.toHaveBeenCalled();
    });
  });

  describe('upsertSubscription', () => {
    const input = {
      appBlockId: 'ab_x',
      scope: 'viewer_personal' as const,
      targetModelTypes: null,
      targetBaseModels: null,
      settings: {},
    };

    it('(a) non-mod OWNER (the caller) + flag ON → upserts, stamping ctx.user.id (NOT input)', async () => {
      mockDbReadAppBlockFindUnique.mockResolvedValue({
        blockId: 'g',
        status: 'approved',
        approvedScopes: [],
        manifest: {},
      });
      mockUpsertSubscription.mockResolvedValue({ id: 'bus_new' });
      const caller = blocksRouter.createCaller(authedCtx(OWNER_ID, false) as never);
      await caller.upsertSubscription(input);
      // userId is stamped server-side from the session, never from input.
      expect(mockUpsertSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ userId: OWNER_ID, appBlockId: 'ab_x' })
      );
    });

    it('(b) non-mod + flag ON + app NOT approved → BAD_REQUEST, never upserts', async () => {
      // The "owner" boundary for a per-user subscription is the approved-app gate
      // + the session-stamped userId; a non-approved app is rejected outright.
      mockDbReadAppBlockFindUnique.mockResolvedValue({ blockId: 'g', status: 'pending' });
      const caller = blocksRouter.createCaller(authedCtx(OWNER_ID, false) as never);
      await expect(caller.upsertSubscription(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mockUpsertSubscription).not.toHaveBeenCalled();
    });

    it('(c) flag OFF (live for a non-mod) → UNAUTHORIZED before the body', async () => {
      mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
      const caller = blocksRouter.createCaller(authedCtx(OWNER_ID, false) as never);
      await expect(caller.upsertSubscription(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(mockDbReadAppBlockFindUnique).not.toHaveBeenCalled();
      expect(mockUpsertSubscription).not.toHaveBeenCalled();
    });
  });

  describe('deleteSubscription', () => {
    const input = { subscriptionId: 'bus_x' };

    it('(a) non-mod OWNER + flag ON → forwards subscriptionId + session userId to the owner-checking service', async () => {
      const caller = blocksRouter.createCaller(authedCtx(OWNER_ID, false) as never);
      const out = await caller.deleteSubscription(input);
      expect(out).toEqual({ ok: true });
      // The service rejects when existing.userId !== opts.userId; the router
      // always passes ctx.user.id (never an input userId), so a non-mod can only
      // delete their OWN subscription.
      expect(mockDeleteSubscription).toHaveBeenCalledWith({
        subscriptionId: 'bus_x',
        userId: OWNER_ID,
      });
    });

    it('(b) non-mod NON-owner + flag ON → service throws authorization, surfaced by the router', async () => {
      // Model the service-layer owner check (existing.userId !== opts.userId).
      mockDeleteSubscription.mockRejectedValue(
        new TRPCError({ code: 'UNAUTHORIZED', message: 'Not the subscription owner' })
      );
      const caller = blocksRouter.createCaller(authedCtx(OTHER_ID, false) as never);
      await expect(caller.deleteSubscription(input)).rejects.toBeInstanceOf(TRPCError);
      expect(mockDeleteSubscription).toHaveBeenCalledWith({
        subscriptionId: 'bus_x',
        userId: OTHER_ID,
      });
    });

    it('(c) flag OFF (live for a non-mod) → UNAUTHORIZED before the body', async () => {
      mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
      const caller = blocksRouter.createCaller(authedCtx(OWNER_ID, false) as never);
      await expect(caller.deleteSubscription(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(mockDeleteSubscription).not.toHaveBeenCalled();
    });
  });
});
