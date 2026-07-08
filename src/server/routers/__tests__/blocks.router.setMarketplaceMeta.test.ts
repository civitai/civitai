import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-E E4 — `blocks.setMarketplaceMeta` + `blocks.getFeaturedBlocks` router
 * coverage. Drives the REAL blocks router so the procedure middleware chain
 * (`moderatorProcedure` = publicProcedure → isAuthed → isMod) is what decides
 * the outcome; `BlockRegistry` is mocked at the module boundary so this suite
 * exercises the GATE (not the service logic, which has its own test).
 *
 * GATING INVARIANT pinned here (each FAILS if the gate is dropped):
 *   - setMarketplaceMeta is MOD-ONLY:
 *       · anon (no session)  → UNAUTHORIZED, service NEVER called.
 *       · non-mod (logged in) → FORBIDDEN,    service NEVER called.
 *       · moderator           → served, service called with the input.
 *   - getFeaturedBlocks is anon-CAPABLE but DARK behind the flag:
 *       · anon WITHOUT the flag → EMPTY rail, service NOT consulted.
 *       · anon WITH the flag (lit path) → served — proves anon-capable, no
 *         isModerator belt.
 */

const {
  mockIsAppBlocksEnabled,
  mockSetMarketplaceMeta,
  mockGetFeaturedBlocks,
  mockGetMarketplaceMeta,
} = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockSetMarketplaceMeta: vi.fn(),
  mockGetFeaturedBlocks: vi.fn(),
  mockGetMarketplaceMeta: vi.fn(),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    listAvailable: vi.fn(),
    getAppDetail: vi.fn(),
    getFeaturedBlocks: (...a: unknown[]) => mockGetFeaturedBlocks(...a),
    getMarketplaceMeta: (...a: unknown[]) => mockGetMarketplaceMeta(...a),
    setMarketplaceMeta: (...a: unknown[]) => mockSetMarketplaceMeta(...a),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    listUserSubscriptions: vi.fn(),
    resolveBlockInstance: vi.fn(),
  },
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: vi.fn(),
  parseSubjectUserId: vi.fn(),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: vi.fn(),
  createWorkflowStepsFromGraphInput: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(),
}));
vi.mock('~/server/services/user.service', () => ({ getUserById: vi.fn() }));
vi.mock('~/server/db/client', () => ({
  dbRead: { appBlock: { findUnique: vi.fn() } },
  dbWrite: { modelBlockInstall: { findUnique: vi.fn() }, model: { findUnique: vi.fn() } },
}));
vi.mock('~/server/redis/client', async () => {
  const actual = await vi.importActual<typeof import('@civitai/redis/client')>('@civitai/redis/client');
  return {
    ...actual,
    redis: { get: vi.fn(), set: vi.fn() },
    sysRedis: { get: vi.fn(), incrBy: vi.fn(), expire: vi.fn(), ttl: vi.fn() },
  };
});
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: vi.fn(async () => ({ yellow: 0, blue: 0, green: 0 })),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(async () => undefined) }));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function fakePerUserFlag(opts?: { user?: { isModerator?: boolean } }) {
  return Promise.resolve(!!opts?.user?.isModerator);
}

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { appBlocks: !!(user as { isModerator?: boolean })?.isModerator } as never,
    track: undefined,
  };
}

const modUser = { id: 1, isModerator: true, tier: 'free', username: 'mod' };
const normalUser = { id: 2, isModerator: false, tier: 'free', username: 'user' };

const META_RESULT = {
  appBlockId: 'ab_1',
  status: 'approved',
  category: 'games',
  featured: true,
  featuredOrder: 3,
};

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset();
  mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
  mockSetMarketplaceMeta.mockReset();
  mockSetMarketplaceMeta.mockResolvedValue(META_RESULT);
  mockGetFeaturedBlocks.mockReset();
  mockGetFeaturedBlocks.mockResolvedValue([]);
  mockGetMarketplaceMeta.mockReset();
  mockGetMarketplaceMeta.mockResolvedValue(META_RESULT);
});

const SET_INPUT = { appBlockId: 'ab_1', category: 'games', featured: true, featuredOrder: 3 } as const;

describe('blocks.setMarketplaceMeta — MOD-ONLY curation write (F-E E4)', () => {
  it('anon (no session): UNAUTHORIZED, the write is NEVER attempted', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.setMarketplaceMeta(SET_INPUT)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockSetMarketplaceMeta).not.toHaveBeenCalled();
  });

  it('non-mod (logged in): FORBIDDEN, the write is NEVER attempted', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.setMarketplaceMeta(SET_INPUT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockSetMarketplaceMeta).not.toHaveBeenCalled();
  });

  it('moderator: served — the write runs with the validated input', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.setMarketplaceMeta(SET_INPUT);
    expect(result).toEqual(META_RESULT);
    expect(mockSetMarketplaceMeta).toHaveBeenCalledTimes(1);
    // The service receives the parsed input (the tRPC input pipeline may add a
    // shared `browsingLevel` default), so assert the curation fields explicitly
    // rather than an exact-equal on the whole object.
    const arg = mockSetMarketplaceMeta.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      appBlockId: 'ab_1',
      category: 'games',
      featured: true,
      featuredOrder: 3,
    });
  });

  it('rejects an off-taxonomy category at the schema layer (write NEVER attempted)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(
      // @ts-expect-error — deliberately an invalid category to prove the enum
      // validation rejects it before the service runs.
      caller.setMarketplaceMeta({ appBlockId: 'ab_1', category: 'totally-made-up' })
    ).rejects.toBeTruthy();
    expect(mockSetMarketplaceMeta).not.toHaveBeenCalled();
  });

  it('allows clearing the category (null) for a mod', async () => {
    mockSetMarketplaceMeta.mockResolvedValue({ ...META_RESULT, category: null });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.setMarketplaceMeta({ appBlockId: 'ab_1', category: null });
    expect(result.category).toBeNull();
    const arg = mockSetMarketplaceMeta.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({ appBlockId: 'ab_1', category: null });
  });
});

describe('blocks.getMarketplaceMeta — MOD-ONLY read (F-E E4)', () => {
  it('anon: UNAUTHORIZED, the read is NEVER attempted', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getMarketplaceMeta({ appBlockId: 'ab_1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockGetMarketplaceMeta).not.toHaveBeenCalled();
  });

  it('non-mod: FORBIDDEN, the read is NEVER attempted', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.getMarketplaceMeta({ appBlockId: 'ab_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockGetMarketplaceMeta).not.toHaveBeenCalled();
  });

  it('moderator: served; NOT_FOUND when the app is missing', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    expect(await caller.getMarketplaceMeta({ appBlockId: 'ab_1' })).toEqual(META_RESULT);

    mockGetMarketplaceMeta.mockResolvedValue(null);
    await expect(caller.getMarketplaceMeta({ appBlockId: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('blocks.getFeaturedBlocks — anon-capable, dark behind the flag (F-E E4)', () => {
  it('anon WITHOUT the flag: gate disables → EMPTY rail, service NOT consulted', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    const result = await caller.getFeaturedBlocks({ limit: 12 });
    expect(result).toEqual({ items: [] });
    expect(mockGetFeaturedBlocks).not.toHaveBeenCalled();
  });

  it('non-mod WITHOUT the flag: EMPTY rail, service NOT consulted', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    const result = await caller.getFeaturedBlocks({ limit: 12 });
    expect(result).toEqual({ items: [] });
    expect(mockGetFeaturedBlocks).not.toHaveBeenCalled();
  });

  it('anon WITH the flag granted (lit path): served — proves anon-CAPABLE, no isModerator belt', async () => {
    mockIsAppBlocksEnabled.mockResolvedValue(true);
    const featured = [
      {
        id: 'ab_1',
        blockId: 'cool-block',
        appId: 'app_1',
        appName: 'Cool App',
        manifest: { name: 'Cool Block' },
        installCount: 3,
        category: 'games',
        scopesSummary: ['ai:write:budgeted'],
      },
    ];
    mockGetFeaturedBlocks.mockResolvedValue(featured);
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    const result = await caller.getFeaturedBlocks({ limit: 12 });
    expect(result).toEqual({ items: featured });
    // PAGE-ONLY LAUNCH GATE (#2622): a non-mod/anon caller passes launchOnly=true
    // so the featured rail carries launch (page) apps only.
    // 3rd arg = redCapable (NSFW-app-red-only; no host header → false).
    expect(mockGetFeaturedBlocks).toHaveBeenCalledWith(12, true, false);
  });

  it('moderator (the live state today): served — sees ALL featured apps (launchOnly=false)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await caller.getFeaturedBlocks({ limit: 12 });
    expect(mockGetFeaturedBlocks).toHaveBeenCalledTimes(1);
    // Mods bypass the page-only launch gate → launchOnly=false (all apps).
    // 3rd arg = redCapable (no host → false). Maturity is a host property, not a
    // privilege — even a mod on .com does not see mature apps here.
    expect(mockGetFeaturedBlocks).toHaveBeenCalledWith(12, false, false);
  });
});
