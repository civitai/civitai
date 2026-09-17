import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The host↔block postMessage bridge procedures in `blocks.router.ts` are authed by a
 * block JWT alone. `verifyBlockToken` checks the signature, the issuer/audience and the
 * expiry — and NOTHING about whether the install still exists or the app is still
 * allowed to run. So before `authorizeBlockBridgeToken` existed, revoking an install
 * (uninstall / toggle-off) or suspending the app left every already
 * minted token driving the bridge until its natural expiry.
 *
 * The REST `withBlockScope` wrapper has always enforced revocation
 * (`block-scope.middleware.ts`), as have the two tRPC resolvers beside this one
 * (`resolveStorageContext` in apps.router, `resolveSharedContext` in
 * apps-shared.router). The bridge was the remaining gap.
 *
 * WHAT IS PINNED HERE — the two guards, per bridge proc, as BEHAVIOUR:
 *   - a revoked `blockInstanceId` ⇒ FORBIDDEN `block instance revoked`;
 *   - a backing `app_blocks` row that is missing ⇒ NOT_FOUND, or not `approved`
 *     ⇒ FORBIDDEN `app block is not approved`;
 *   - and the positive control beside each: the SAME call, with the SAME fixture, and
 *     only the guarded condition flipped, still succeeds. Without that control a
 *     guard test passes just as well against a proc that rejects everything.
 *
 * The messages are asserted verbatim, not just the code: every gate on these procs
 * answers FORBIDDEN, so a code-only assertion is satisfied by a DIFFERENT guard
 * rejecting the fixture — which is exactly how a mutation to the revocation check
 * dies for the wrong reason.
 */

const {
  mockIsAppBlocksEnabled,
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockGetUserById,
  mockGetUserBuzzAccounts,
  mockGetSessionUser,
  mockIsRevoked,
  mockListMyBlockWorkflows,
} = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetUserBuzzAccounts: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockIsRevoked: vi.fn(),
  mockListMyBlockWorkflows: vi.fn(),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/services/blocks/app-analytics.service', () => ({
  getMyAppAnalytics: vi.fn(),
  emptyAnalytics: vi.fn(),
  resolveRange: vi.fn(),
}));
vi.mock('~/server/services/blocks/buzz-attribution.service', () => ({
  getRevenueForOwner: vi.fn(),
  getRecentAttributionsForOwner: vi.fn(),
  emptyRevenue: vi.fn(),
  recordSpendAttribution: vi.fn(),
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (...a: unknown[]) => mockParseSubjectUserId(...a),
}));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: (...a: unknown[]) => mockIsRevoked(...a) },
}));
vi.mock('~/server/services/blocks/block-workflows.service', () => ({
  listMyBlockWorkflows: (...a: unknown[]) => mockListMyBlockWorkflows(...a),
  upsertBlockWorkflowOnSubmit: vi.fn(),
  updateBlockWorkflowStatus: vi.fn(),
  blockWorkflowOwnedByAppUser: vi.fn(),
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
vi.mock('~/server/services/user.service', () => ({
  getUserById: (...a: unknown[]) => mockGetUserById(...a),
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => mockGetSessionUser(...a) },
}));
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: (...a: unknown[]) => mockGetUserBuzzAccounts(...a),
  getUserBuzzAccount: vi.fn(),
  getUserBuzzTransactions: vi.fn(),
  getDailyCompensationRewardByUser: vi.fn(),
}));
vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  recordScopeInvocation: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    listAvailable: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    upsertUserSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    resolveBlockInstance: vi.fn(),
    listUserSubscriptions: vi.fn(),
  },
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mockDbRead = dbMock.dbRead;

function validClaims(over: Record<string, unknown> = {}) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'jti_test',
    blockId: 'blk_test',
    appId: 'app_test',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_test',
    ctx: {},
    scopes: ['buzz:read:self', 'ai:write:budgeted'],
    ...over,
  };
}

function fakeCtx() {
  return {
    acceptableOrigin: true,
    user: undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}
const caller = () => blocksRouter.createCaller(fakeCtx() as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyBlockToken.mockResolvedValue(validClaims());
  mockParseSubjectUserId.mockImplementation((sub: string) =>
    sub === 'anon' ? null : Number(sub.split(':')[1])
  );
  // `assertAppBlocksEnabledForTokenUser` hydrates the TOKEN subject, then evaluates the
  // kill-switch against it. Both on, so neither can be the reason a call is refused.
  mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: true });
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockGetUserBuzzAccounts.mockResolvedValue({ blue: 1, green: 2, yellow: 3 });
  mockListMyBlockWorkflows.mockResolvedValue({ items: [], nextCursor: null });
  // Default world: the install is live and the app is approved — so every rejection
  // below is attributable to the one condition that test flips.
  mockIsRevoked.mockResolvedValue(false);
  mockDbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_test', status: 'approved' });
});

describe('bridge guard — revocation', () => {
  it('lets a live, approved instance through (positive control)', async () => {
    await expect(caller().getMyBuzzBalance({ blockToken: 't' })).resolves.toEqual({
      blue: 1,
      green: 2,
      yellow: 3,
    });
  });

  it('403s getMyBuzzBalance for a revoked blockInstanceId', async () => {
    mockIsRevoked.mockResolvedValue(true);
    await expect(caller().getMyBuzzBalance({ blockToken: 't' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'block instance revoked',
    });
  });

  it('403s listMyWorkflows for a revoked blockInstanceId', async () => {
    mockIsRevoked.mockResolvedValue(true);
    await expect(caller().listMyWorkflows({ blockToken: 't' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'block instance revoked',
    });
  });

  it('checks the token claim, not client input', async () => {
    mockIsRevoked.mockResolvedValue(false);
    await caller().getMyBuzzBalance({ blockToken: 't' });
    expect(mockIsRevoked).toHaveBeenCalledWith('bki_test');
  });

  it('refuses BEFORE the app-block read — revocation is the cheaper check and runs first', async () => {
    mockIsRevoked.mockResolvedValue(true);
    await expect(caller().getMyBuzzBalance({ blockToken: 't' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockDbRead.appBlock.findUnique).not.toHaveBeenCalled();
  });
});

describe('bridge guard — approved status', () => {
  it('403s getMyBuzzBalance when the app_blocks row is not approved', async () => {
    mockDbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_test', status: 'suspended' });
    await expect(caller().getMyBuzzBalance({ blockToken: 't' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'app block is not approved',
    });
  });

  it('403s listMyWorkflows when the app_blocks row is not approved', async () => {
    mockDbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_test', status: 'pending' });
    await expect(caller().listMyWorkflows({ blockToken: 't' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'app block is not approved',
    });
  });

  it('404s when the app_blocks row has gone', async () => {
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    await expect(caller().getMyBuzzBalance({ blockToken: 't' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  /**
   * The one exemption, and the reason it is not a hole: `/api/v1/block-tokens`'s
   * `tryDevTunnelOwnedNonApprovedMint` mints a dev token carrying the app's REAL ids for
   * an app that is deliberately NOT approved — a suspended/pending/deprecated app stays
   * runnable by its OWNER in the owner's own dev tunnel (self-bound, forced-SFW,
   * budget-capped, tunnel-gated, never public). Enforcing the approved status on a `dev`
   * token would break that documented path. Revocation still binds — see below.
   */
  it('skips the approved check for a dev token, which may legitimately be non-approved', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ dev: true }));
    mockDbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_test', status: 'suspended' });
    await expect(caller().getMyBuzzBalance({ blockToken: 't' })).resolves.toMatchObject({
      blue: 1,
    });
  });

  it('still revokes a dev token — the exemption is the approved check only', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ dev: true }));
    mockIsRevoked.mockResolvedValue(true);
    await expect(caller().getMyBuzzBalance({ blockToken: 't' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'block instance revoked',
    });
  });
});

describe('bridge guard — token validity', () => {
  it('401s an unverifiable token, before either new check runs', async () => {
    mockVerifyBlockToken.mockResolvedValue(null);
    await expect(caller().getMyBuzzBalance({ blockToken: 't' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'invalid block token',
    });
    expect(mockIsRevoked).not.toHaveBeenCalled();
    expect(mockDbRead.appBlock.findUnique).not.toHaveBeenCalled();
  });
});
