import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W13 P4 — `blocks.listMyPublishRequests` OWNER-control augmentation.
 *
 * Asserts the ROUTER query now carries, per publish-request row: the backing
 * on-site `AppListing.id` + its TRUE lifecycle `status` (distinct from the request
 * status), the last moderation action for a REMOVED listing (owner-hidden vs
 * mod-removed), and `hasPage` (does the manifest declare a launch page). Also pins
 * the BATCHED shape — ONE `appListing.findMany` + ONE `appListingModerationEvent
 * .findMany` for the whole page, NOT an N+1 per row.
 *
 * Same heavy-mock skeleton as `blocks.router.getMyAppAnalytics.test.ts` (services
 * stubbed so importing the router doesn't drag in the generated Prisma client);
 * `getFeatureFlags` is mocked so the `appDeveloperProcedure` author gate passes.
 */

const { mockIsAppBlocksEnabled } = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: vi.fn(async () => true),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/services/feature-flags.service')>()),
  getFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true, appBlocksPages: false }),
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: vi.fn(),
  parseSubjectUserId: vi.fn(),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({ getOrchestratorToken: vi.fn() }));
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: vi.fn(),
  createWorkflowStepsFromGraphInput: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({ auditPromptServer: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ getUserById: vi.fn() }));
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({ getUserBuzzAccounts: vi.fn() }));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    listAvailable: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    resolveBlockInstance: vi.fn(),
  },
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import {
  LISTING_STATUS_CHANGING_MODERATION_ACTIONS,
  STATE_NEUTRAL_MODERATION_ACTIONS,
} from '~/server/services/blocks/app-listing-owner-unpublish';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbRead = dbMock.dbRead;

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { appBlocks: true, appBlocksAuthor: true } as never,
    track: undefined,
  };
}

const owner = { id: 7, isModerator: false, tier: 'free', username: 'owner' };

/** A page-app manifest (declares a launch page → hasPage true). */
const PAGE_MANIFEST = { name: 'App', page: { path: '/' } };
/** A model-slot manifest (no page → hasPage false). */
const SLOT_MANIFEST = { name: 'App', targets: ['model.sidebar_top'] };

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockDbRead.blockUserSubscription.groupBy.mockResolvedValue([]);
  mockDbRead.appListing.findMany.mockResolvedValue([]);
  mockDbRead.appListingModerationEvent.findMany.mockResolvedValue([]);
});

describe('listMyPublishRequests — P4 owner-control augmentation', () => {
  it('carries the backing listing id + TRUE status + hasPage; a LIVE (approved) listing has no last action', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      {
        id: 'req-1',
        appBlockId: null,
        slug: 'live-app',
        version: '1.0.0',
        status: 'approved',
        submittedAt: new Date('2026-01-01'),
        reviewedAt: new Date('2026-01-02'),
        rejectionReason: null,
        approvalNotes: null,
        deployState: 'live',
        deployDetail: null,
        deployUpdatedAt: new Date('2026-01-02'),
        fileSummary: null,
        manifestDiffSummary: null,
        appBlock: { id: 'block-a', manifest: PAGE_MANIFEST, _count: { userSubscriptions: 4 } },
      },
    ]);
    mockDbRead.appListing.findMany.mockResolvedValue([
      { id: 'l-a', appBlockId: 'block-a', status: 'approved', _count: { screenshots: 3 } },
    ]);

    const caller = blocksRouter.createCaller(fakeCtx(owner) as never);
    const rows = await caller.listMyPublishRequests();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      appListingId: 'l-a',
      listingStatus: 'approved',
      lastModerationAction: null,
      hasPage: true,
    });
    // Approved (live) listing → NO moderation-action lookup (only removed listings).
    expect(mockDbRead.appListingModerationEvent.findMany).not.toHaveBeenCalled();
  });

  it('a REMOVED listing carries its last moderation action (owner-hidden vs mod-removed), BATCHED (one findMany, not N+1)', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      {
        id: 'req-h',
        appBlockId: null,
        slug: 'hidden-app',
        version: '1.0.0',
        status: 'approved',
        submittedAt: new Date('2026-01-01'),
        reviewedAt: new Date('2026-01-02'),
        rejectionReason: null,
        approvalNotes: null,
        deployState: 'live',
        deployDetail: null,
        deployUpdatedAt: null,
        fileSummary: null,
        manifestDiffSummary: null,
        appBlock: { id: 'block-h', manifest: SLOT_MANIFEST, _count: { userSubscriptions: 0 } },
      },
      {
        id: 'req-m',
        appBlockId: null,
        slug: 'gone-app',
        version: '1.0.0',
        status: 'approved',
        submittedAt: new Date('2026-01-01'),
        reviewedAt: new Date('2026-01-02'),
        rejectionReason: null,
        approvalNotes: null,
        deployState: 'live',
        deployDetail: null,
        deployUpdatedAt: null,
        fileSummary: null,
        manifestDiffSummary: null,
        appBlock: { id: 'block-m', manifest: PAGE_MANIFEST, _count: { userSubscriptions: 0 } },
      },
    ]);
    mockDbRead.appListing.findMany.mockResolvedValue([
      { id: 'l-h', appBlockId: 'block-h', status: 'removed', _count: { screenshots: 3 } },
      { id: 'l-m', appBlockId: 'block-m', status: 'removed', _count: { screenshots: 3 } },
    ]);
    mockDbRead.appListingModerationEvent.findMany.mockResolvedValue([
      { appListingId: 'l-h', action: 'owner-unpublish' },
      { appListingId: 'l-m', action: 'delist' },
    ]);

    const caller = blocksRouter.createCaller(fakeCtx(owner) as never);
    const rows = await caller.listMyPublishRequests();

    const byListing = Object.fromEntries(rows.map((r) => [r.appListingId, r]));
    expect(byListing['l-h']).toMatchObject({
      listingStatus: 'removed',
      lastModerationAction: 'owner-unpublish',
      hasPage: false, // slot manifest
    });
    expect(byListing['l-m']).toMatchObject({
      listingStatus: 'removed',
      lastModerationAction: 'delist',
      hasPage: true, // page manifest
    });
    // BATCHED: exactly ONE moderation-event query for the whole page, over BOTH
    // removed listing ids (not one query per row).
    expect(mockDbRead.appListingModerationEvent.findMany).toHaveBeenCalledTimes(1);
    const modArgs = mockDbRead.appListingModerationEvent.findMany.mock.calls[0][0];
    expect(modArgs.where.appListingId.in.sort()).toEqual(['l-h', 'l-m']);
    expect(modArgs.distinct).toEqual(['appListingId']);
    // And exactly ONE backing-listing query for the whole page.
    expect(mockDbRead.appListing.findMany).toHaveBeenCalledTimes(1);
  });

  it('a row with no backing listing (pending first version) → null listing fields, null last action', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      {
        id: 'req-p',
        appBlockId: null,
        slug: 'pending-app',
        version: '1.0.0',
        status: 'pending',
        submittedAt: new Date('2026-01-01'),
        reviewedAt: null,
        rejectionReason: null,
        approvalNotes: null,
        deployState: null,
        deployDetail: null,
        deployUpdatedAt: null,
        fileSummary: null,
        manifestDiffSummary: null,
        appBlock: null,
      },
    ]);

    const caller = blocksRouter.createCaller(fakeCtx(owner) as never);
    const rows = await caller.listMyPublishRequests();

    expect(rows[0]).toMatchObject({
      appListingId: null,
      listingStatus: null,
      lastModerationAction: null,
      hasPage: false,
    });
    // No app-block ids on the page → no backing-listing / moderation queries at all.
    expect(mockDbRead.appListing.findMany).not.toHaveBeenCalled();
    expect(mockDbRead.appListingModerationEvent.findMany).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 THE LAST-ACTION READ MUST ASK THE SAME QUESTION THE SERVER GATE ASKS.
 *
 * `lastModerationAction` is what /apps/mine maps to `owner-hidden` (Republish offered) vs
 * `mod-removed` (Republish hidden, "removed by a moderator"). The SERVER gate that decides
 * whether Republish actually works — `republishOwnListing`, and the author edit paths —
 * reads `readLastModerationAction`, which filters to
 * `LISTING_STATUS_CHANGING_MODERATION_ACTIONS`. This read was UNFILTERED, so the two
 * disagreed the moment a state-neutral event landed on top: a moderator's `message-owner`
 * ("fix X and republish"), a `claim`, or a `report-resolve` became the newest row, the
 * client saw "not owner-unpublish" and hid Republish on a listing the server would happily
 * republish — killing the exact repair loop this feature exists for.
 *
 * These pin the WHERE clause (the guard itself), not the projected shape.
 */
describe('listMyPublishRequests — the last-action read is FILTERED to status-changing actions', () => {
  const removedRow = (id: string, blockId: string) => ({
    id,
    appBlockId: null,
    slug: `${id}-app`,
    version: '1.0.0',
    status: 'approved',
    submittedAt: new Date('2026-01-01'),
    reviewedAt: new Date('2026-01-02'),
    rejectionReason: null,
    approvalNotes: null,
    deployState: 'live',
    deployDetail: null,
    deployUpdatedAt: null,
    fileSummary: null,
    manifestDiffSummary: null,
    appBlock: { id: blockId, manifest: PAGE_MANIFEST, _count: { userSubscriptions: 0 } },
  });

  async function lastEventWhere() {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([removedRow('req-h', 'block-h')]);
    mockDbRead.appListing.findMany.mockResolvedValue([
      { id: 'l-h', appBlockId: 'block-h', status: 'removed', _count: { screenshots: 3 } },
    ]);
    mockDbRead.appListingModerationEvent.findMany.mockResolvedValue([
      { appListingId: 'l-h', action: 'owner-unpublish' },
    ]);
    const caller = blocksRouter.createCaller(fakeCtx(owner) as never);
    await caller.listMyPublishRequests();
    expect(mockDbRead.appListingModerationEvent.findMany).toHaveBeenCalledTimes(1);
    return (
      mockDbRead.appListingModerationEvent.findMany.mock.calls[0][0] as {
        where: { action?: { in?: string[] } };
      }
    ).where;
  }

  it('🔴 carries an `action IN (…)` predicate at all — the clause whose absence is the bug', async () => {
    const where = await lastEventWhere();
    expect(where.action).toBeDefined();
    // POSITIVE CONTROL on the same read: the list is non-empty, so a `not.toContain`
    // below cannot pass merely because nothing is there.
    expect(where.action?.in?.length).toBeGreaterThan(0);
  });

  it('🔴 uses the SHARED constant verbatim — not a second hand-typed spelling', async () => {
    const where = await lastEventWhere();
    expect(where.action?.in).toEqual([...LISTING_STATUS_CHANGING_MODERATION_ACTIONS]);
  });

  it.each([...STATE_NEUTRAL_MODERATION_ACTIONS])(
    '🔴 %s cannot displace the removal event — excluded by the WHERE clause',
    async (neutral) => {
      const where = await lastEventWhere();
      expect(where.action?.in).not.toContain(neutral);
    }
  );

  it('still admits both an owner unpublish and a moderator takedown', async () => {
    const where = await lastEventWhere();
    expect(where.action?.in).toContain('owner-unpublish');
    expect(where.action?.in).toContain('delist');
    expect(where.action?.in).toContain('purge');
  });
});

/**
 * OWNER-ONLY VISIBILITY — the security boundary for the build-failure excerpt.
 *
 * `deployDetail` now carries a sanitized slice of the app's BUILD LOG. That is
 * the author's own material and must reach the author (and moderators, via the
 * separate mod procs) and NOBODY ELSE. The guard is the `submittedByUserId`
 * filter on this query — there is no post-filter and no per-row ownership check,
 * so if that `where` clause were ever dropped or widened, every viewer would see
 * every developer's build output.
 *
 * These tests pin the filter itself rather than the shape of the result, because
 * the filter IS the guard.
 */
describe('listMyPublishRequests — OWNER-ONLY scoping (guards the build-failure excerpt)', () => {
  const otherUser = { id: 999, isModerator: false, tier: 'free', username: 'someone-else' };

  it('scopes the query to the CALLING user id — the only ownership guard there is', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
    const caller = blocksRouter.createCaller(fakeCtx(owner) as never);
    await caller.listMyPublishRequests();

    const args = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(args.where).toEqual({ submittedByUserId: owner.id });
  });

  it('a DIFFERENT caller queries with THEIR id — never a shared/unscoped read', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
    const caller = blocksRouter.createCaller(fakeCtx(otherUser) as never);
    await caller.listMyPublishRequests();

    const args = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(args.where).toEqual({ submittedByUserId: otherUser.id });
    expect(args.where.submittedByUserId).not.toBe(owner.id);
  });

  it('an ANONYMOUS caller gets nothing and NO query is issued at all', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.listMyPublishRequests()).rejects.toBeTruthy();
    expect(mockDbRead.appBlockPublishRequest.findMany).not.toHaveBeenCalled();
  });

  it('selects the build-failure excerpt for the owner (deployDetail is returned)', async () => {
    const EXCERPT = 'Build Failed\n\nERROR: no package-lock.json is committed';
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      {
        id: 'req-f',
        appBlockId: null,
        slug: 'failed-app',
        version: '1.0.0',
        status: 'approved',
        submittedAt: new Date('2026-01-01'),
        reviewedAt: new Date('2026-01-02'),
        rejectionReason: null,
        approvalNotes: null,
        deployState: 'failed',
        deployDetail: EXCERPT,
        deployUpdatedAt: new Date('2026-01-02'),
        fileSummary: null,
        manifestDiffSummary: null,
        appBlock: null,
      },
    ]);
    const caller = blocksRouter.createCaller(fakeCtx(owner) as never);
    const rows = await caller.listMyPublishRequests();
    expect(rows[0]).toMatchObject({ deployState: 'failed', deployDetail: EXCERPT });

    // And the select explicitly asks for it (pins the projection, not just the row).
    const args = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0] as {
      select: Record<string, unknown>;
    };
    expect(args.select.deployDetail).toBe(true);
    expect(args.select.reviewedAt).toBe(true); // the STRANDED-detection anchor
  });
});

// ---------------------------------------------------------------------------
// The KIND seam of the completeness advisory.
// ---------------------------------------------------------------------------

/**
 * 🔴 `computeListingProblems` now gives DIFFERENT advice per listing kind for
 * `empty-description` / `empty-tagline` / `empty-category`, because an ON-SITE listing's
 * copy has no author surface other than `block.manifest.json` — `approveRequest`'s
 * (3b-sync) re-sync overwrites those scalars from the manifest on every subsequent-version
 * approve. This router is one of THREE call sites that must thread the kind; a call site
 * that is missed keeps the old, wrong advice on its surface and NOTHING else goes red.
 *
 * 🔴 THE OFF-SITE CASE HERE IS THE DISCRIMINATING CONTROL, and it is deliberately an
 * ANOMALOUS row. This query's `where` filters `kind: 'onsite'`, so in production every row
 * is on-site — which means an assertion that on-site rows get the manifest label passes
 * EQUALLY against a hardcoded literal `'onsite'` at the call site. Feeding a row whose
 * `kind` COLUMN says `offsite` is the only case that can tell "reads the column" from
 * "spells the constant": it fails iff the value is hardcoded. That is why the router
 * projects the column instead of restating the filter's conclusion.
 *
 * 🔴 WHICH CASES ARE REGRESSION COVERAGE. Measured at `origin/main` 4bfd4c16d: 3 of the
 * 5 cases below go RED — the on-site label, the `kind` projection, and the narrow-fake
 * degrade. The other 2 PASS at base and are INVARIANT GUARDS, not coverage of this bug:
 * at base EVERY listing got the original label, so the off-site discriminating control
 * and the code-invariance case were green by construction. The discriminating control
 * still earns its place — it is the ONLY case that kills a hardcoded `'onsite'` at the
 * call site (M10 in the sweep), which no on-site assertion can do.
 */
describe('listMyPublishRequests — the advisory is KIND-AWARE', () => {
  const MANIFEST_TAGLINE = 'Missing tagline — set "tagline" in block.manifest.json and resubmit';
  const ORIGINAL_TAGLINE = 'Missing tagline';

  /** A request row whose backing listing has every asset but NO tagline. */
  const requestRow = (id: string, blockId: string) => ({
    id,
    appBlockId: null,
    slug: `app-${id}`,
    version: '1.0.0',
    status: 'approved',
    submittedAt: new Date('2026-01-01'),
    reviewedAt: new Date('2026-01-02'),
    rejectionReason: null,
    approvalNotes: null,
    deployState: 'live',
    deployDetail: null,
    deployUpdatedAt: new Date('2026-01-02'),
    fileSummary: null,
    manifestDiffSummary: null,
    appBlock: { id: blockId, manifest: PAGE_MANIFEST, _count: { userSubscriptions: 0 } },
  });

  /**
   * The listing row as the (select-honouring) query would return it. Assets present and
   * pairwise distinct (icon 41, cover 53, screenshots 7) so only the TEXT problem fires
   * and no expected value can be produced by reading a neighbouring field. `kind` has no
   * default — every call states it.
   */
  const listingRow = (id: string, blockId: string, kind: string) => ({
    id,
    appBlockId: blockId,
    status: 'approved',
    kind,
    iconId: 41,
    coverId: 53,
    description: 'A description.',
    tagline: null,
    category: 'utility',
    _count: { screenshots: 7 },
  });

  const taglineLabelOf = (row: { problems: { code: string; label: string }[] }) =>
    row.problems.find((p) => p.code === 'empty-tagline')?.label;

  it('an ON-SITE backing listing names block.manifest.json', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([requestRow('req-on', 'blk-on')]);
    mockDbRead.appListing.findMany.mockResolvedValue([listingRow('l-on', 'blk-on', 'onsite')]);

    const caller = blocksRouter.createCaller(fakeCtx(owner) as never);
    const rows = await caller.listMyPublishRequests();

    // Positive control: exactly the one text problem, so the label assertion is not
    // reading whichever problem happened to land first.
    expect(rows[0].problems.map((p) => p.code)).toEqual(['empty-tagline']);
    expect(taglineLabelOf(rows[0])).toBe(MANIFEST_TAGLINE);
  });

  it('🔴 DISCRIMINATING CONTROL — a row whose kind COLUMN says offsite gets the ORIGINAL label', async () => {
    // Fails iff the call site hardcodes 'onsite' instead of reading the projected column.
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      requestRow('req-off', 'blk-off'),
    ]);
    mockDbRead.appListing.findMany.mockResolvedValue([listingRow('l-off', 'blk-off', 'offsite')]);

    const caller = blocksRouter.createCaller(fakeCtx(owner) as never);
    const rows = await caller.listMyPublishRequests();

    expect(rows[0].problems.map((p) => p.code)).toEqual(['empty-tagline']);
    expect(taglineLabelOf(rows[0])).toBe(ORIGINAL_TAGLINE);
  });

  it('the CODE is identical either way (wire contract — a released CLI branches on `code`)', async () => {
    for (const kind of ['onsite', 'offsite']) {
      vi.clearAllMocks();
      mockIsAppBlocksEnabled.mockResolvedValue(true);
      mockDbRead.blockUserSubscription.groupBy.mockResolvedValue([]);
      mockDbRead.appListingModerationEvent.findMany.mockResolvedValue([]);
      mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([requestRow('req-k', 'blk-k')]);
      mockDbRead.appListing.findMany.mockResolvedValue([listingRow('l-k', 'blk-k', kind)]);

      const caller = blocksRouter.createCaller(fakeCtx(owner) as never);
      const rows = await caller.listMyPublishRequests();
      expect(
        rows[0].problems.map((p) => p.code),
        `kind=${kind}`
      ).toEqual(['empty-tagline']);
    }
  });

  it('the listing query PROJECTS `kind` (a dropped projection silently reverts this)', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([requestRow('req-p', 'blk-p')]);
    mockDbRead.appListing.findMany.mockResolvedValue([listingRow('l-p', 'blk-p', 'onsite')]);

    const caller = blocksRouter.createCaller(fakeCtx(owner) as never);
    await caller.listMyPublishRequests();

    const args = mockDbRead.appListing.findMany.mock.calls[0][0] as {
      select: Record<string, unknown>;
      where: Record<string, unknown>;
    };
    expect(args.select.kind).toBe(true);
    // The filter this projection deliberately does NOT restate at the call site.
    expect(args.where.kind).toBe('onsite');
  });

  it('a narrow fake omitting `kind` degrades to the on-site labels (this query only admits on-site rows)', async () => {
    // The pre-existing cases in this file use exactly such a fake; this pins that the
    // fallback is the honest one for THIS caller rather than an accident.
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([requestRow('req-n', 'blk-n')]);
    mockDbRead.appListing.findMany.mockResolvedValue([
      {
        id: 'l-n',
        appBlockId: 'blk-n',
        status: 'approved',
        tagline: null,
        _count: { screenshots: 7 },
      },
    ]);

    const caller = blocksRouter.createCaller(fakeCtx(owner) as never);
    const rows = await caller.listMyPublishRequests();
    expect(taglineLabelOf(rows[0])).toBe(MANIFEST_TAGLINE);
  });
});
