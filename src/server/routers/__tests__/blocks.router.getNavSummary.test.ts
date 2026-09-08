import { GLOBAL_SCOPE_ACTIVITY_OR } from '~/server/services/blocks/scope-activity-predicate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * `getNavSummary` — the lightweight booleans that drive the conditional tabs in
 * the apps sub-nav (`AppsSubNav`). This test asserts the ROUTER wiring:
 *   - protectedProcedure + enforceAppBlocksFlag gate (anon rejected; flag-off
 *     returns the all-false shape and runs NO query);
 *   - each existence check is a `findFirst` scoped to `ctx.user.id` (no
 *     cross-user leakage);
 *   - the returned booleans reflect presence/absence per table;
 *   - `isReviewer` is derived from the session user (real `isAppReviewer`,
 *     which is `isModerator`-only).
 *
 * Same mock skeleton as blocks.router.getMyAppAnalytics.test.ts (heavy services
 * stubbed so importing the router doesn't drag in the stale generated Prisma
 * client). The three nav-summary tables are mocked on `dbRead` at the boundary.
 */

const {
  mockIsAppBlocksEnabled,
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockGetUserById,
  mockGetUserBuzzAccounts,
} = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetUserBuzzAccounts: vi.fn(),
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
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (...a: unknown[]) => mockParseSubjectUserId(...a),
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
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: (...a: unknown[]) => mockGetUserBuzzAccounts(...a),
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    listAvailable: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
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
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbRead = dbMock.dbRead;
const mockRedis = redisMock.redis;
const mockSysRedis = redisMock.sysRedis;
const mockLogToAxiom = loggingMock.logToAxiom;

// enforceAppBlocksFlag gates on isAppBlocksEnabled({ user }); the live flag is
// base-false with a moderators segment. Model that: flag ON iff user is a mod.
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

// App Blocks is mod-only pre-GA, so a flag-on user is a moderator → isReviewer
// is true for these. (`isAppReviewer` is the real impl = isModerator-only.)
const modUser = { id: 7, isModerator: true, tier: 'free', username: 'mod' };
const otherModUser = { id: 99, isModerator: true, tier: 'free', username: 'mod2' };

const ALL_FALSE = {
  hasInstalls: false,
  hasActivity: false,
  hasSubmissions: false,
  hasApprovedApps: false,
  isReviewer: false,
  hasEditableApps: false,
  hasPendingInvites: false,
};

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset();
  mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
  mockDbRead.blockUserSubscription.findFirst.mockReset();
  mockDbRead.blockBuzzAttribution.findFirst.mockReset();
  mockDbRead.blockScopeInvocation.findFirst.mockReset();
  mockDbRead.appBlockPublishRequest.findFirst.mockReset();
  mockDbRead.appBlock.findFirst.mockReset();
  mockDbRead.appListing.findFirst.mockReset();
  mockDbRead.appCollaborator.findFirst.mockReset();
  mockDbRead.appOwnershipTransfer.findFirst.mockReset();
  // Default: nothing exists for anyone.
  mockDbRead.blockUserSubscription.findFirst.mockResolvedValue(null);
  mockDbRead.blockBuzzAttribution.findFirst.mockResolvedValue(null);
  mockDbRead.blockScopeInvocation.findFirst.mockResolvedValue(null);
  mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
  mockDbRead.appBlock.findFirst.mockResolvedValue(null);
  mockDbRead.appListing.findFirst.mockResolvedValue(null);
  mockDbRead.appCollaborator.findFirst.mockResolvedValue(null);
  mockDbRead.appOwnershipTransfer.findFirst.mockResolvedValue(null);
});

describe('getNavSummary — gate', () => {
  it('anonymous: rejected (protectedProcedure) before any query runs', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getNavSummary()).rejects.toBeInstanceOf(TRPCError);
    expect(mockDbRead.blockUserSubscription.findFirst).not.toHaveBeenCalled();
    expect(mockDbRead.appBlockPublishRequest.findFirst).not.toHaveBeenCalled();
    expect(mockDbRead.appBlock.findFirst).not.toHaveBeenCalled();
    expect(mockDbRead.appListing.findFirst).not.toHaveBeenCalled();
    expect(mockDbRead.appCollaborator.findFirst).not.toHaveBeenCalled();
    expect(mockDbRead.appOwnershipTransfer.findFirst).not.toHaveBeenCalled();
  });

  it('flag OFF: returns the all-false shape and runs NO existence query', async () => {
    // A logged-in non-mod has the appBlocks flag dark → enforceAppBlocksFlag
    // marks _appBlocksDisabled on the query ctx → the proc short-circuits.
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result).toEqual(ALL_FALSE);
    expect(mockDbRead.blockUserSubscription.findFirst).not.toHaveBeenCalled();
    expect(mockDbRead.appBlockPublishRequest.findFirst).not.toHaveBeenCalled();
    expect(mockDbRead.appBlock.findFirst).not.toHaveBeenCalled();
    expect(mockDbRead.appListing.findFirst).not.toHaveBeenCalled();
    expect(mockDbRead.appCollaborator.findFirst).not.toHaveBeenCalled();
  });
});

describe('getNavSummary — booleans reflect existence', () => {
  it('user with NONE of {installs, submissions, approved apps}: all-false except isReviewer (mod)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result).toEqual({
      hasInstalls: false,
      hasActivity: false,
      hasSubmissions: false,
      hasApprovedApps: false,
      isReviewer: true, // flag-on user is a mod pre-GA
      hasEditableApps: false,
      hasPendingInvites: false,
    });
  });

  it('hasInstalls true ONLY when a subscription row exists', async () => {
    mockDbRead.blockUserSubscription.findFirst.mockResolvedValue({ id: 'bus_1' });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result.hasInstalls).toBe(true);
    expect(result.hasSubmissions).toBe(false);
    expect(result.hasApprovedApps).toBe(false);
  });

  it('hasSubmissions true ONLY when a publish-request row exists', async () => {
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({ id: 'pr_1' });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result.hasSubmissions).toBe(true);
    expect(result.hasInstalls).toBe(false);
    expect(result.hasApprovedApps).toBe(false);
  });

  it('hasApprovedApps true ONLY when an approved owned app exists', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue({ id: 'apb_1' });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result.hasApprovedApps).toBe(true);
    expect(result.hasInstalls).toBe(false);
    expect(result.hasSubmissions).toBe(false);
  });

  it('all three present: every flag true', async () => {
    mockDbRead.blockUserSubscription.findFirst.mockResolvedValue({ id: 'bus_1' });
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({ id: 'pr_1' });
    mockDbRead.appBlock.findFirst.mockResolvedValue({ id: 'apb_1' });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result).toEqual({
      hasInstalls: true,
      hasActivity: false,
      hasSubmissions: true,
      hasApprovedApps: true,
      isReviewer: true,
      hasEditableApps: false,
      hasPendingInvites: false,
    });
  });
});

/**
 * 🔴 `hasActivity` — THE FLAG THAT LETS THE `Activity` TAB SEE A FULL-PAGE-APP VIEWER.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * The sub-nav's Activity row keyed on `hasInstalls` alone, i.e. on a
 * `block_user_subscriptions` row — a SLOT install. A full-page app
 * (`/apps/run/<slug>`) is STATELESS by design and writes no such row ("no
 * `block_user_subscriptions` row, no migration"), so a viewer who only ever runs page
 * apps has a populated activity feed and NO tab pointing at it. Widening the PAGE's gate
 * to `appBlocks || appBlocksPages` did not fix that — the tab is what was missing.
 *
 * ── WHY THESE TWO TABLES AND NOT ANY OTHER ───────────────────────────────────
 * They are the two the FEED walks: `listMyAppActivity` reads `block_buzz_attribution`
 * filtered on the SPENDER's `userId`, and `listMyScopeInvocations` reads
 * `block_scope_invocations` on the same column (both in
 * `~/server/services/blocks/user-app-surface.service`). A probe on a table the feed does
 * NOT read would light a tab over a page that renders "No activity yet" — the mirror of
 * the defect being fixed. That correspondence is what the per-table cases below assert.
 *
 * ── RED WITHOUT THE CHANGE ───────────────────────────────────────────────────
 * Delete the `hasActivity` key from the procedure's return and every test in this block
 * fails on its own assertion (`expected undefined to be true`). Delete only ONE of the
 * two disjuncts and exactly one of the two per-table cases fails.
 */
describe('getNavSummary — hasActivity (page-app activity, no installs)', () => {
  it('🔴 a BUZZ-ATTRIBUTION row alone lights hasActivity — with hasInstalls FALSE', async () => {
    mockDbRead.blockBuzzAttribution.findFirst.mockResolvedValue({ id: 'bba_1' });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result.hasActivity).toBe(true);
    // The whole point: this viewer has NO subscription row.
    expect(result.hasInstalls).toBe(false);
  });

  it('🔴 a SCOPE-INVOCATION row alone lights hasActivity — with hasInstalls FALSE', async () => {
    mockDbRead.blockScopeInvocation.findFirst.mockResolvedValue({ id: '42' });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result.hasActivity).toBe(true);
    expect(result.hasInstalls).toBe(false);
  });

  it('NEGATIVE CONTROL: an INSTALL alone does not light hasActivity', async () => {
    // Without this the two cases above are satisfied by `hasActivity` being wired to
    // anything at all, including `hasInstalls` itself.
    mockDbRead.blockUserSubscription.findFirst.mockResolvedValue({ id: 'bus_1' });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result.hasInstalls).toBe(true);
    expect(result.hasActivity).toBe(false);
  });

  it('both probes empty ⇒ false (the flag is not constant-true)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    expect((await caller.getNavSummary()).hasActivity).toBe(false);
  });

  it('each activity probe is scoped to ctx.user.id and selects only id (LIMIT 1)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(otherModUser) as never);
    await caller.getNavSummary();

    const buzzArgs = mockDbRead.blockBuzzAttribution.findFirst.mock.calls[0][0];
    // `userId` is the SPENDER on this table, not the app owner — the same column the
    // feed filters on. An owner-scoped probe would light the tab for the wrong person.
    expect(buzzArgs.where).toEqual({ userId: otherModUser.id });
    expect(buzzArgs.select).toEqual({ id: true });

    const scopeArgs = mockDbRead.blockScopeInvocation.findFirst.mock.calls[0][0];
    expect(scopeArgs.where.userId).toBe(otherModUser.id);
    expect(scopeArgs.select).toEqual({ id: true });
  });

  it('🔴 the scope probe MIRRORS the feed: external-OAuth rows are excluded', async () => {
    // The global feed keeps `app-block` + synthetic dev-tunnel rows
    // (`appBlockId IS NOT NULL OR syntheticAppId IS NOT NULL`) and drops external-OAuth
    // rows, which carry BOTH columns null. Without this term an external-OAuth-only
    // viewer gets an Activity tab whose feed says "No activity yet".
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await caller.getNavSummary();
    const where = mockDbRead.blockScopeInvocation.findFirst.mock.calls[0][0].where;

    // 🔴 IDENTITY, NOT EQUALITY — and that distinction is the whole guard. An audit WALKED the
    // previous version of this check: it replaced the spread with a differently-spelled
    // divergent predicate, left the `GLOBAL_SCOPE_ACTIVITY_OR` mention alive in a comment, and
    // updated this test's own literal — the edit a developer making that change would make —
    // and every suite stayed green (67/67) while the probe and the feed silently diverged.
    // A `toEqual` against a literal cannot tell "read the shared constant" from "re-spelled
    // the same clause"; `toBe` on the array reference can only pass if the object the router
    // handed Prisma IS the exported one. That makes the single-sourcing structural instead of
    // spelled — the exact upgrade this ladder keeps having to make.
    expect(
      where.OR,
      'the probe did not pass the SHARED predicate to Prisma — it re-spelled its own copy'
    ).toBe(GLOBAL_SCOPE_ACTIVITY_OR.OR);

    // …and the shared constant still means what the feed needs. Kept as a second, cheap
    // assertion so a change to the constant itself is not invisible here.
    expect(where.OR).toEqual([{ appBlockId: { not: null } }, { syntheticAppId: { not: null } }]);
  });

  it('flag OFF: neither activity probe runs', async () => {
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    expect((await caller.getNavSummary()).hasActivity).toBe(false);
    expect(mockDbRead.blockBuzzAttribution.findFirst).not.toHaveBeenCalled();
    expect(mockDbRead.blockScopeInvocation.findFirst).not.toHaveBeenCalled();
  });
});

describe('getNavSummary — own-data scoping (no cross-user)', () => {
  it('each existence check is scoped to ctx.user.id + selects only id (LIMIT 1)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(otherModUser) as never);
    await caller.getNavSummary();

    const subArgs = mockDbRead.blockUserSubscription.findFirst.mock.calls[0][0];
    expect(subArgs.where).toEqual({ userId: otherModUser.id });
    expect(subArgs.select).toEqual({ id: true });

    const prArgs = mockDbRead.appBlockPublishRequest.findFirst.mock.calls[0][0];
    expect(prArgs.where).toEqual({ submittedByUserId: otherModUser.id });
    expect(prArgs.select).toEqual({ id: true });

    const appArgs = mockDbRead.appBlock.findFirst.mock.calls[0][0];
    expect(appArgs.where).toEqual({ app: { userId: otherModUser.id }, status: 'approved' });
    expect(appArgs.select).toEqual({ id: true });
  });

  it('approved-app check filters on status=approved (not pending/rejected apps)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await caller.getNavSummary();
    const appArgs = mockDbRead.appBlock.findFirst.mock.calls[0][0];
    expect(appArgs.where.status).toBe('approved');
  });

  it('uses findFirst (existence), never count — count({take:1}) is a full COUNT(*)', async () => {
    // Regression guard for the audit fix: the proc must use findFirst, not
    // count. If a `count` mock is referenced the call would be undefined here.
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await caller.getNavSummary();
    expect(mockDbRead.blockUserSubscription.findFirst).toHaveBeenCalledTimes(1);
    expect(mockDbRead.appBlockPublishRequest.findFirst).toHaveBeenCalledTimes(1);
    expect(mockDbRead.appBlock.findFirst).toHaveBeenCalledTimes(1);
  });
});

/**
 * 🔴 THE TWO COLLABORATOR-AWARE FLAGS. Both are OWNER-INDEPENDENT: a collaborator who
 * owns nothing has `hasInstalls`/`hasSubmissions`/`hasApprovedApps` all false, so without
 * these there is NO nav route to an app they can genuinely edit, and no route to the
 * invitation that got them there.
 */
describe('getNavSummary — the collaborator-aware flags', () => {
  it('hasEditableApps is TRUE from an OWNED listing alone (no seat)', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValue({ id: 'apl_1' });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result.hasEditableApps).toBe(true);
    expect(result.hasPendingInvites).toBe(false);
  });

  it('🔴 hasEditableApps is TRUE from an ACCEPTED SEAT alone — owning nothing', async () => {
    // The whole point: `hasSubmissions` and `hasApprovedApps` stay false here.
    mockDbRead.appCollaborator.findFirst.mockImplementation(
      async (args: { where: { status: string } }) =>
        args.where.status === 'accepted' ? { appListingId: 'apl_1' } : null
    );
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result.hasEditableApps).toBe(true);
    expect(result.hasSubmissions).toBe(false);
    expect(result.hasApprovedApps).toBe(false);
  });

  it('🔴 an inbound OWNERSHIP-TRANSFER OFFER lights "Invites" through the router', async () => {
    // The router-level half of the gap: `/apps/invites` renders a pending transfer offer
    // as well as a seat invite, so the tab that routes there must see both. With seats
    // empty, the ONLY thing that can light this flag is the transfer probe.
    mockDbRead.appOwnershipTransfer.findFirst.mockResolvedValue({ id: 'aot_1' });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result.hasPendingInvites).toBe(true);
    // …and an offer confers no capability, so "My apps" stays dark.
    expect(result.hasEditableApps).toBe(false);
  });

  it('the transfer probe is scoped to ctx.user.id as the ADDRESSEE, and status-filtered', async () => {
    // Cross-user leakage is the failure this shape prevents: `toUserId` is the addressee,
    // so an offer the caller SENT can never light their own tab.
    const caller = blocksRouter.createCaller(fakeCtx(otherModUser) as never);
    await caller.getNavSummary();
    const where = mockDbRead.appOwnershipTransfer.findFirst.mock.calls[0][0].where;
    expect(where.toUserId).toBe(otherModUser.id);
    expect(where.status).toBe('pending');
    // Expiry is a READ-TIME predicate with no sweeper — a dead offer keeps
    // `status='pending'` forever, so this bound is what stops the tab latching on.
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
    expect(where.fromUserId).toBeUndefined();
  });

  it('a PENDING seat does NOT light "My apps" — only "Invites"', async () => {
    // An unaccepted invite confers ZERO capability; offering an editor route for it
    // would be offering a page every child query refuses.
    mockDbRead.appCollaborator.findFirst.mockImplementation(
      async (args: { where: { status: string } }) =>
        args.where.status === 'pending' ? { appListingId: 'apl_1' } : null
    );
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result.hasPendingInvites).toBe(true);
    expect(result.hasEditableApps).toBe(false);
  });

  it('the seat probes are scoped to ctx.user.id and split by status', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(otherModUser) as never);
    await caller.getNavSummary();
    const statuses = mockDbRead.appCollaborator.findFirst.mock.calls.map(
      (c: unknown[]) => (c[0] as { where: { userId: number; status: string } }).where
    );
    expect(statuses).toEqual([
      { userId: otherModUser.id, status: 'accepted' },
      { userId: otherModUser.id, status: 'pending' },
    ]);
  });

  it('ownership is resolved KIND-AWARE, shadows excluded — same predicate as listMine', async () => {
    // 🔴 WAS "BLOCK-FIRST" (two branches) UNTIL ISSUE #3844. That predicate let an
    // attached `AppBlock` decide ownership on an OFF-SITE listing, where
    // `AppListing.userId` is canonical — so after `claimListing` or an off-site
    // `acceptTransfer` (both of which move only the column) the sub-nav offered the
    // "My apps" route to the PREVIOUS owner and hid it from the rightful one. The third
    // branch is that fix, and this assertion is enumerated equality on purpose: it is the
    // structural half of "the tab and the page it opens cannot disagree", the other half
    // being `app-access.kind-aware-owner.test.ts`, which asserts both reads pass the
    // shared `canonicalOwnerWhereBranches` output.
    const caller = blocksRouter.createCaller(fakeCtx(otherModUser) as never);
    await caller.getNavSummary();
    const where = mockDbRead.appListing.findFirst.mock.calls[0][0].where;
    expect(where.revisionOfId).toBeNull();
    expect(where.OR).toEqual([
      { kind: 'onsite', appBlock: { app: { userId: otherModUser.id } } },
      { kind: 'onsite', appBlock: { is: null }, userId: otherModUser.id },
      { kind: { not: 'onsite' }, userId: otherModUser.id },
    ]);
  });

  it('🔴 the seat probes DEGRADE to false when the manual-apply table is absent', async () => {
    // An un-degraded read here would 500 the sub-nav — every /apps page's chrome — for
    // the whole window between the code deploy and a human applying the migration.
    mockDbRead.appCollaborator.findFirst.mockRejectedValue(
      Object.assign(new Error('relation "app_collaborators" does not exist'), { code: '42P01' })
    );
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result.hasEditableApps).toBe(false);
    expect(result.hasPendingInvites).toBe(false);
    // …and the non-collaborator flags still answer.
    expect(result.isReviewer).toBe(true);
  });
});
