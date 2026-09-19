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
  mockGetActiveDevTunnel,
} = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetUserBuzzAccounts: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockIsRevoked: vi.fn(),
  mockListMyBlockWorkflows: vi.fn(),
  mockGetActiveDevTunnel: vi.fn(),
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
// The dev-tunnel re-check the approval predicate performs for a dev token on a REAL,
// NOT-approved row. Reached through `await import(...)` inside the predicate — stubbed at
// the specifier, which intercepts the dynamic form identically.
vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  getActiveDevTunnel: (...a: unknown[]) => mockGetActiveDevTunnel(...a),
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
  mockDbRead.appBlock.findUnique.mockResolvedValue({
    id: 'apb_test',
    status: 'approved',
    // The owner, matching `validClaims().sub` (`user:42`). Present on the default row so
    // the ownership belt is satisfied by default and every refusal below stays
    // attributable to the one condition its test flips.
    app: { userId: 42 },
  });
  // Default world: NO active dev tunnel — the exempting condition is opted INTO.
  mockGetActiveDevTunnel.mockResolvedValue(null);
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

  it('checks the token claim, not client input — instance AND subject', async () => {
    mockIsRevoked.mockResolvedValue(false);
    await caller().getMyBuzzBalance({ blockToken: 't' });
    // 🔴 THE SUBJECT IS THE SECOND ARGUMENT AND IT COMES FROM THE TOKEN TOO. It selects
    // the subject-scoped ban keyspace, which exists because `page_ephemeral-<slug>` is
    // not unique across users: a global marker there refuses an innocent author's own
    // dev tunnel. Passing anything client-supplied here would let a caller pick whose
    // revocation they are checked against.
    expect(mockIsRevoked).toHaveBeenCalledWith('bki_test', 'user:42');
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

  it('still revokes a dev token — the exemption is the approved check only', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ dev: true }));
    mockIsRevoked.mockResolvedValue(true);
    await expect(caller().getMyBuzzBalance({ blockToken: 't' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'block instance revoked',
    });
  });
});

/**
 * 🔴 THE DEV-TOKEN EXEMPTION, ON THE BRIDGE (clawgate #571).
 *
 * This block replaces a single test that read *"skips the approved check for a dev token,
 * which may legitimately be non-approved"* and asserted a 200 for `dev: true` against a
 * `suspended` row. That test was true about the code and wrong about the property: the
 * `dev` claim is stamped by SIX mint paths, of which only three may legitimately run a
 * non-approved app, so the guard exempted all six — for the 4h dev lifetime, 16× the
 * 900s default, on all fifteen bridge procedures.
 *
 * WHAT IS PINNED HERE is the split, on the surface the card is about. The fixture subject
 * is `user:42` throughout (`validClaims`), so `app.userId` is what moves between the
 * owner and non-owner cases, and the dev tunnel is what moves between populations A and E.
 * Every case below drives a REAL bridge procedure through the real guard, and each names
 * the population it stands for so a future reader can tell coverage from decoration.
 */
describe('bridge guard — the dev-token populations', () => {
  it('POPULATION E: owner + ACTIVE dev tunnel on a suspended app still drives the bridge', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ dev: true }));
    mockDbRead.appBlock.findUnique.mockResolvedValue({ status: 'suspended', app: { userId: 42 } });
    mockGetActiveDevTunnel.mockResolvedValue({ sessionId: 's', userId: 42, blockId: 'blk_test' });
    await expect(caller().getMyBuzzBalance({ blockToken: 't' })).resolves.toMatchObject({
      blue: 1,
    });
  });

  /**
   * 🔴 THE DEFECT. Population A — a `dev:live` token whose mint REQUIRED
   * `status: 'approved'`, still live after a moderator suspension. Identical in every
   * respect to the test above except the absent dev tunnel, which is the only thing that
   * ever separated it from population E.
   */
  it('POPULATION A: owner with NO dev tunnel is REFUSED on a suspended app', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ dev: true }));
    mockDbRead.appBlock.findUnique.mockResolvedValue({ status: 'suspended', app: { userId: 42 } });
    mockGetActiveDevTunnel.mockResolvedValue(null);
    await expect(caller().getMyBuzzBalance({ blockToken: 't' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'app block is not approved',
    });
  });

  /**
   * The same refusal on a SECOND procedure, because the exemption was never per-proc —
   * it sat in the one guard all fifteen go through, so pinning one proc would understate
   * both the defect and the fix.
   */
  it('POPULATION A: the refusal is the guard, not the procedure — listMyWorkflows too', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ dev: true }));
    mockDbRead.appBlock.findUnique.mockResolvedValue({ status: 'suspended', app: { userId: 42 } });
    mockGetActiveDevTunnel.mockResolvedValue(null);
    await expect(caller().listMyWorkflows({ blockToken: 't' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'app block is not approved',
    });
  });

  it('a dev token whose subject is not the CURRENT owner is refused, tunnel or not', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ dev: true }));
    mockDbRead.appBlock.findUnique.mockResolvedValue({ status: 'suspended', app: { userId: 99 } });
    mockGetActiveDevTunnel.mockResolvedValue({ sessionId: 's', userId: 42, blockId: 'blk_test' });
    await expect(caller().getMyBuzzBalance({ blockToken: 't' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'app block is not approved',
    });
  });

  /**
   * 🔴 CRITERION 5 — the moderator review sandbox, on the bridge. A run-for-real review
   * token belongs to a MODERATOR, not the owner, and names a pending app; it must keep
   * working, and it must do so from its own signed claim rather than by accident. Every
   * other exempting condition is absent here: a suspended row owned by someone else, and
   * no dev tunnel.
   */
  it('POPULATION F′: a run-for-real REVIEW token still drives the bridge on a non-approved app', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ dev: true, reviewRunForReal: true }));
    mockDbRead.appBlock.findUnique.mockResolvedValue({ status: 'suspended', app: { userId: 99 } });
    mockGetActiveDevTunnel.mockResolvedValue(null);
    await expect(caller().getMyBuzzBalance({ blockToken: 't' })).resolves.toMatchObject({
      blue: 1,
    });
    // From the claim alone — the row is never read.
    expect(mockDbRead.appBlock.findUnique).not.toHaveBeenCalled();
  });

  /**
   * POPULATIONS B / C / D / F — the synthetic-id mints. No backing row, so nothing to be
   * approved; on the bridge this is the branch that would otherwise answer NOT_FOUND and
   * silently kill the pending / local-manifest / ephemeral-tunnel sandboxes.
   */
  it('POPULATIONS B–D/F: a dev token with NO backing row still drives the bridge', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ dev: true }));
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    await expect(caller().getMyBuzzBalance({ blockToken: 't' })).resolves.toMatchObject({
      blue: 1,
    });
  });

  /**
   * The corresponding NON-dev case is unchanged and stays a 404 — pinned next to its dev
   * sibling because the two verdicts for a missing row now diverge inside one function,
   * and a reader comparing them needs both in view.
   */
  it('a NON-dev token with no backing row is still NOT_FOUND, not exempt', async () => {
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    await expect(caller().getMyBuzzBalance({ blockToken: 't' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('an APPROVED app with a dev token needs no exemption and never looks for a tunnel', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ dev: true }));
    mockDbRead.appBlock.findUnique.mockResolvedValue({ status: 'approved', app: { userId: 42 } });
    await expect(caller().getMyBuzzBalance({ blockToken: 't' })).resolves.toMatchObject({
      blue: 1,
    });
    // The cost claim in the predicate's docblock: only the dev + real-row + NOT-approved
    // path pays the tunnel lookup.
    expect(mockGetActiveDevTunnel).not.toHaveBeenCalled();
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
