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
  mockIsAppBlocksEnabled,
  mockDbReadAppBlockFindUnique,
  mockGetUserBuzzAccounts,
} = vi.hoisted(() => ({
  mockListUserSubscriptions: vi.fn(),
  mockListAvailable: vi.fn(),
  mockUpsertSubscription: vi.fn(),
  mockDeleteSubscription: vi.fn(async () => undefined),
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  mockDbReadAppBlockFindUnique: vi.fn(),
  mockGetUserBuzzAccounts: vi.fn(async () => ({ yellow: 0, blue: 0, green: 0 })),
}));

vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
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
  dbWrite: { modelBlockInstall: { findUnique: vi.fn() }, model: { findUnique: vi.fn() } },
}));
// Mock the heavy peer modules the router imports so the import graph
// stays cheap and we don't accidentally hit live deps.
vi.mock('~/server/redis/client', () => ({
  redis: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
  // GENERATION.RESOURCE_DATA is read at import time by resource-data.redis (pulled
  // in transitively); without it this suite flakily throws "Cannot read properties
  // of undefined (reading 'RESOURCE_DATA')" depending on test-file load order.
  REDIS_KEYS: { BLOCKS: {}, GENERATION: { RESOURCE_DATA: 'packed:generation:resource-data-3' } },
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
  mockDbReadAppBlockFindUnique.mockReset();
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
    const caller = blocksRouter.createCaller(authedCtx(42, false) as never);
    const out = await caller.listAvailable({ limit: 20 });
    expect(out).toEqual({ items: [], nextCursor: undefined });
    expect(mockListAvailable).not.toHaveBeenCalled();
  });

  it('returns empty for an anon caller (Phase 2 internal-only gate)', async () => {
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
 * Phase 2 — App Blocks is moderator-only until GA. The ~23 management
 * procedures were converted from `guardedProcedure` (= any verified, not-muted
 * user) to `moderatorProcedure` (= protectedProcedure.use(isMod)). A NON-mod
 * but otherwise-valid verified user must now get FORBIDDEN from every one of
 * them. We sample a representative spread (install management, publish-request
 * review, subscription writes, revenue reads) — they all share the same
 * procedure builder, so one regression in `moderatorProcedure` would flip the
 * whole set.
 */
describe('Phase 2 — management procedures reject non-mod verified users (FORBIDDEN)', () => {
  function nonMod() {
    return blocksRouter.createCaller(authedCtx(42, false) as never);
  }

  it('upsertSubscription → FORBIDDEN', async () => {
    await expect(
      nonMod().upsertSubscription({
        appBlockId: 'ab_x',
        scope: 'viewer_personal',
        targetModelTypes: null,
        targetBaseModels: null,
        settings: {},
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockUpsertSubscription).not.toHaveBeenCalled();
    // The app-block lookup must not even run — isMod gates before the body.
    expect(mockDbReadAppBlockFindUnique).not.toHaveBeenCalled();
  });

  it('deleteSubscription → FORBIDDEN', async () => {
    await expect(
      nonMod().deleteSubscription({ subscriptionId: 'bus_x' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDeleteSubscription).not.toHaveBeenCalled();
  });

  // NOTE: listMySubscriptions / listMyScopeGrants / listMyAppActivity /
  // listMyScopeInvocations + the own-data management actions (uninstallFromModel,
  // setSubscriptionPinnedVersion) were GA-relaxed moderator→protected (gotcha
  // #66) — they're own-data and self-scoped, so a non-mod is NO LONGER FORBIDDEN.
  // The non-mod happy path for listMySubscriptions is asserted in the
  // 'blocks.listMySubscriptions (guarded)' describe above. The procedures kept
  // in this block (install/upsert/delete + the mod-review queue + revenue/apps)
  // remain mod-gated.

  it('installOnModel → FORBIDDEN', async () => {
    await expect(
      nonMod().installOnModel({
        modelId: 7,
        appBlockId: 'ab_x',
        slotId: 'model.sidebar_top',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

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
