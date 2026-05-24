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
} = vi.hoisted(() => ({
  mockListUserSubscriptions: vi.fn(),
  mockListAvailable: vi.fn(),
  mockUpsertSubscription: vi.fn(),
  mockDeleteSubscription: vi.fn(async () => undefined),
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  mockDbReadAppBlockFindUnique: vi.fn(),
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
  REDIS_KEYS: { BLOCKS: {} },
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

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function authedCtx(userId: number) {
  return {
    acceptableOrigin: true,
    // onboarding=0x1F covers all flags including OnboardingSteps.Buzz (8) so
    // the guardedProcedure's onboarding middleware passes. The exact flag set
    // doesn't matter for the auth-gate tests; we just need the middleware
    // to forward to the procedure body.
    user: { id: userId, isModerator: false, onboarding: 0x1f } as never,
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

  it('forwards query/slot/limit input to the service', async () => {
    mockListAvailable.mockResolvedValue({ items: [], nextCursor: undefined });
    const caller = blocksRouter.createCaller(anonCtx() as never);
    await caller.listAvailable({
      query: 'generate',
      slotId: 'model.sidebar_top',
      limit: 5,
    });
    expect(mockListAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'generate', slotId: 'model.sidebar_top', limit: 5 })
    );
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

  it('passes per-block-id-validated settings to the service for first-party blocks', async () => {
    mockDbReadAppBlockFindUnique.mockResolvedValue({
      blockId: 'generate-from-model',
      status: 'approved',
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

  it('rejects settings that violate per-block-id schema (out-of-range buzz budget)', async () => {
    mockDbReadAppBlockFindUnique.mockResolvedValue({
      blockId: 'generate-from-model',
      status: 'approved',
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
