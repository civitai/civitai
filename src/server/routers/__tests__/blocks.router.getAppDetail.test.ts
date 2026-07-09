import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-E E2 — `blocks.getAppDetail` router coverage: the anon-capable per-app
 * detail read path that backs `/apps/<appBlockId>`.
 *
 * `isAppBlocksEnabled` is mocked with a FAITHFUL per-user implementation
 * (mirrors the live `moderators`-segmented flag: ON only when the supplied user
 * is a moderator). The test drives the REAL blocks router so the middleware's
 * `{ user: ctx.user }` wiring is what decides the outcome. `BlockRegistry` is
 * mocked at the module boundary so this suite exercises the router's gate +
 * NOT_FOUND mapping (the projection/security is covered by the service test
 * `block-registry.get-app-detail.test.ts`).
 *
 * GATING INVARIANT pinned here (FAILS if regressed):
 *   - anon WITHOUT the flag → NOT_FOUND, registry NEVER consulted (DARK today).
 *   - non-mod WITHOUT the flag → NOT_FOUND, registry NEVER consulted.
 *   - anon WITH the flag granted (the lit path post-segment-widen) → served;
 *     proves it is anon-CAPABLE, NOT mod-only — there is NO isModerator belt.
 *   - moderator (the live state) → served.
 *   - a non-approved / missing app → NOT_FOUND (service returns null).
 */

const { mockIsAppBlocksEnabled, mockGetAppDetail } = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockGetAppDetail: vi.fn(),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    listAvailable: vi.fn(),
    getAppDetail: (...a: unknown[]) => mockGetAppDetail(...a),
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
// rateLimit pulls in heavy deps (redis + caches → stale Prisma client in a
// fresh worktree). Stub it to a pass-through middleware built from the real
// lightweight factory; the gate under test is the flag middleware.
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

const PUBLIC_DETAIL = {
  id: 'ab_1',
  blockId: 'cool-block',
  appId: 'app_1',
  appName: 'Cool App',
  manifest: { name: 'Cool Block', description: 'd', targets: [{ slotId: 'model.sidebar_top' }] },
  scopes: ['ai:write:budgeted'],
  contentRating: 'PG',
  version: '1.0.0',
  installCount: 3,
  liveUrl: 'https://cool-block.civit.ai',
};

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset();
  mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
  mockGetAppDetail.mockReset();
  mockGetAppDetail.mockResolvedValue(PUBLIC_DETAIL);
});

const input = { appBlockId: 'ab_1' };

describe('blocks.getAppDetail — anon-capable, dark behind the flag (F-E E2)', () => {
  it('anon WITHOUT the flag: gate disables → NOT_FOUND, registry NOT consulted (dark today)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getAppDetail(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockGetAppDetail).not.toHaveBeenCalled();
    expect(mockIsAppBlocksEnabled).toHaveBeenCalledWith({ user: undefined });
  });

  it('non-mod WITHOUT the flag: gate disables → NOT_FOUND, registry NOT consulted', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.getAppDetail(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockGetAppDetail).not.toHaveBeenCalled();
  });

  it('anon WITH the flag granted (lit path): served — proves anon-CAPABLE, no isModerator belt', async () => {
    // Simulate the post-launch segment widen: the flag resolves ON even with no
    // user. getAppDetail is publicProcedure; there is NO secondary isModerator
    // gate left to block this. (This test FAILS if an isModerator belt is added.)
    mockIsAppBlocksEnabled.mockResolvedValue(true);
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    const result = await caller.getAppDetail(input);
    expect(result).toEqual(PUBLIC_DETAIL);
    // PAGE-ONLY LAUNCH GATE: an anon caller is non-mod → launchOnly=true is
    // passed to the service (which restricts to page apps; that filtering is
    // covered in block-registry.page-only-launch.test.ts — here the service is
    // mocked, so we only assert the forwarded arg).
    // NSFW-APP-RED-ONLY: the 3rd arg is redCapable, derived from the request
    // host. The fake ctx carries no host header → not red-capable → false.
    expect(mockGetAppDetail).toHaveBeenCalledWith('ab_1', true, false);
  });

  it('moderator (the live state today): served, launchOnly=false (grandfather)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getAppDetail(input);
    expect(result).toEqual(PUBLIC_DETAIL);
    expect(mockGetAppDetail).toHaveBeenCalledTimes(1);
    // A moderator sees everything → launchOnly=false. redCapable=false (no host).
    expect(mockGetAppDetail).toHaveBeenCalledWith('ab_1', false, false);
  });

  it('NOT_FOUND when the service returns null (missing / non-approved app)', async () => {
    mockGetAppDetail.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.getAppDetail(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
