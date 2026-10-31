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
 *   - anon WITH the flag granted, on a PUBLIC listing → served (anon-capable).
 *   - moderator (the live state) → served.
 *   - a non-approved / missing app → NOT_FOUND (service returns null).
 *
 * LISTING-VISIBILITY GATE (civitai/flipt-state#263 widens the flag to everyone, so the flag
 * can no longer stand in for the audience): the backing listing's level is applied with the
 * SAME predicate the store detail uses (`listingVisibleInStore` + the viewer's audience
 * floor). The database is driven through the canonical `dbMock`, so the real access
 * resolver and the real level reader execute:
 *   - `dbRead.appBlock.findUnique`       → `resolveAppAccess` (owner / editor seat);
 *   - `dbRead.appCollaborator.findFirst` → the accepted editor seat;
 *   - `dbRead.appListing.findFirst`      → the block's canonical listing (status);
 *   - `dbRead.$queryRaw`                 → `readListingVisibility` (the level column).
 */

const { mockIsAppBlocksEnabled, mockGetAppDetail, mockFloor } = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockGetAppDetail: vi.fn(),
  mockFloor: vi.fn(),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  resolveViewerAudienceFloor: mockFloor,
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
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: vi.fn(async () => ({ yellow: 0, blue: 0, green: 0 })),
}));
// rateLimit pulls in heavy deps (redis + caches → stale Prisma client in a
// fresh worktree). Stub it to a pass-through middleware built from the real
// lightweight factory; the gate under test is the flag middleware.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

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

/** The faithful floor: a moderator floors at `moderators`, anyone else at `public` unless a
 * test names them a tester. */
function fakeFloor(opts?: { user?: { isModerator?: boolean } }) {
  return Promise.resolve(opts?.user?.isModerator === true ? 'moderators' : 'public');
}

const OWNER_ID = 77;
const EDITOR_ID = 78;

/** The block's canonical listing, at `status` and `visibility` (null = level unset). */
function listingIs(status: string, visibility: string | null) {
  dbMock.dbRead.appListing.findFirst.mockResolvedValue({ id: 'al_1', status } as never);
  dbMock.dbRead.$queryRaw.mockResolvedValue([{ visibility }] as never);
}

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset();
  mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
  mockGetAppDetail.mockReset();
  mockGetAppDetail.mockResolvedValue(PUBLIC_DETAIL);
  mockFloor.mockReset();
  mockFloor.mockImplementation(fakeFloor);
  // The app is owned by OWNER_ID; EDITOR_ID holds an accepted seat on its listing.
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({
    id: 'ab_1',
    app: { userId: OWNER_ID },
    appListing: { id: 'al_1' },
  } as never);
  dbMock.dbRead.appCollaborator.findFirst.mockImplementation((async (args: {
    where: { userId: number };
  }) => (args.where.userId === EDITOR_ID ? { userId: EDITOR_ID } : null)) as never);
  // Default: an approved listing with no level set (the pre-feature rule: visible).
  listingIs('approved', null);
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
    listingIs('approved', 'public');
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

describe("blocks.getAppDetail — the listing's visibility level applies (post civitai/flipt-state#263)", () => {
  // `app-blocks-enabled` is on for EVERYONE in every case below — the state #263 creates — so
  // the flag no longer decides anything and the listing's level must.
  beforeEach(() => {
    mockIsAppBlocksEnabled.mockResolvedValue(true);
  });

  const viewer = (id: number) => ({ id, isModerator: false, tier: 'free', username: `u${id}` });
  const asTester = () => mockFloor.mockResolvedValue('testers');

  it('🔴 a signed-in NON-tester cannot fetch a testers-only app: NOT_FOUND, like a missing one', async () => {
    listingIs('approved', 'testers');
    const caller = blocksRouter.createCaller(fakeCtx(viewer(5)) as never);
    await expect(caller.getAppDetail(input)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'App block not found',
    });
  });

  it('🔴 a SIGNED-OUT caller cannot fetch a testers-only app', async () => {
    listingIs('approved', 'testers');
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getAppDetail(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('🔴 a private app is NOT_FOUND to a non-owner, even a tester (private is off the store)', async () => {
    asTester();
    listingIs('approved', 'private');
    const caller = blocksRouter.createCaller(fakeCtx(viewer(5)) as never);
    await expect(caller.getAppDetail(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('🔴 an app with NO listing fails closed to NOT_FOUND for a non-owner', async () => {
    dbMock.dbRead.appListing.findFirst.mockResolvedValue(null as never);
    const caller = blocksRouter.createCaller(fakeCtx(viewer(5)) as never);
    await expect(caller.getAppDetail(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a TESTER can fetch a testers-only app', async () => {
    asTester();
    listingIs('approved', 'testers');
    const caller = blocksRouter.createCaller(fakeCtx(viewer(5)) as never);
    await expect(caller.getAppDetail(input)).resolves.toEqual(PUBLIC_DETAIL);
  });

  it('the OWNER (not a tester) can fetch their own testers-only and private app', async () => {
    for (const level of ['testers', 'private']) {
      listingIs('approved', level);
      const caller = blocksRouter.createCaller(fakeCtx(viewer(OWNER_ID)) as never);
      await expect(caller.getAppDetail(input)).resolves.toEqual(PUBLIC_DETAIL);
    }
  });

  it('an accepted COLLABORATOR (not a tester) can fetch the app', async () => {
    listingIs('approved', 'private');
    const caller = blocksRouter.createCaller(fakeCtx(viewer(EDITOR_ID)) as never);
    await expect(caller.getAppDetail(input)).resolves.toEqual(PUBLIC_DETAIL);
  });

  it('a MODERATOR can fetch testers-only and private apps (unchanged)', async () => {
    for (const level of ['testers', 'private', 'moderators']) {
      listingIs('approved', level);
      const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
      await expect(caller.getAppDetail(input)).resolves.toEqual(PUBLIC_DETAIL);
    }
  });

  it('CONTROL: the same non-tester CAN fetch a public app, so the refusals above are the level', async () => {
    listingIs('approved', 'public');
    const caller = blocksRouter.createCaller(fakeCtx(viewer(5)) as never);
    await expect(caller.getAppDetail(input)).resolves.toEqual(PUBLIC_DETAIL);
  });
});
