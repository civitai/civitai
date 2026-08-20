import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `listListingHistory` — the LAZY, per-row read behind an expanded `/apps/mine` row.
 *
 * 🔴 THE FINDING THIS FILE PINS. There are TWO publish-request tables and they are NOT
 * duplicates, so the merged history must UNION them rather than pick one or deduplicate:
 *
 *   - `app_block_publish_requests` — the CODE/VERSION stream. Written by
 *     `publish-request.service` (submit / submit-version / approve / reject / withdraw /
 *     the deploy callbacks) and by the suspend→re-queue clone in
 *     `offsite-moderation.service`. Carries `version`, `manifest`, `bundleSha256`,
 *     `deployState`.
 *   - `app_listing_publish_requests` — the STORE-LISTING stream. It has exactly THREE
 *     `create` sites in the tree, and only ONE of them can emit `kind: 'onsite'`:
 *     `submitListingRevision`, which passes `kind: shadow.kind`. So every on-site row in
 *     that table is a shadow-REVISION request (a change to the listing's name/media/
 *     category), never a code submission — `listMySubmissions` states the same invariant
 *     in prose: *"all onsite requests are shadow revisions"*.
 *
 * A version bump and a listing edit are DIFFERENT EVENTS on the same app. Deduplicating
 * them would delete real history; ignoring one table would hide half of it.
 *
 * `resolveListingAccess` is deliberately NOT stubbed — it runs for real against the fake
 * `appListing.findUnique`, so the authorization assertions below are about the real gate
 * rather than about a stub.
 */

/**
 * 🔴 THE DB IS MOCKED THROUGH THE CANONICAL SHARED MOCK, not a per-file
 * per-file mock of the db-client specifier. Under `isolate: false` a per-file mock freezes
 * that one file's mock shape into every LATER file in the same worker — a file that mocks
 * nothing at all then fails on a missing export. `src/__tests__/setup.ts` registers `dbMock` once
 * for every file and resets it between them, and
 * `src/server/services/__tests__/no-direct-shared-module-mock.test.ts` fails on any new
 * direct mock of a guarded specifier — it caught this file. That guard is a TEXT scan, so
 * the call it forbids cannot even be quoted in this comment.
 */
const mockDb = dbMock.dbRead;
const mockWriteDb = dbMock.dbWrite;
void mockWriteDb;

const {
  listListingHistory,
  listMyOrphanedSubmissions,
  blockRequestWhereForListing,
  canWithdrawRequest,
  LISTING_HISTORY_LIMIT,
} = await import('~/server/services/blocks/app-listing-history.service');

const OWNER = 41;
const SEAT = 52;
const STRANGER = 63;

/** An ON-SITE listing owned by `OWNER` through its block's OauthClient. */
function onsiteListing(over: Record<string, unknown> = {}) {
  return {
    id: 'apl_main',
    userId: OWNER,
    slug: 'main-app',
    kind: 'onsite',
    appBlockId: 'ab_main',
    revisionOfId: null,
    appBlock: { app: { userId: OWNER } },
    revisionOf: null,
    ...over,
  };
}

/** An OFF-SITE listing owned by `OWNER` through the column (no block at all). */
function offsiteListing(over: Record<string, unknown> = {}) {
  return {
    id: 'apl_ext',
    userId: OWNER,
    slug: 'ext-app',
    kind: 'offsite',
    appBlockId: null,
    revisionOfId: null,
    appBlock: null,
    revisionOf: null,
    ...over,
  };
}

const listingReq = (over: Record<string, unknown> & { id: string }) => ({
  status: 'approved',
  submittedByUserId: OWNER,
  submittedAt: new Date('2026-05-01T00:00:00Z'),
  reviewedAt: null,
  rejectionReason: null,
  approvalNotes: null,
  changelog: null,
  ...over,
});

const blockReq = (over: Record<string, unknown> & { id: string }) => ({
  version: '1.0.0',
  status: 'approved',
  submittedByUserId: OWNER,
  submittedAt: new Date('2026-05-01T00:00:00Z'),
  reviewedAt: null,
  rejectionReason: null,
  approvalNotes: null,
  deployState: null,
  deployUpdatedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.appListing.findUnique.mockImplementation(async () => null);
  mockDb.appCollaborator.findFirst.mockImplementation(async () => null);
  mockDb.appListingPublishRequest.findMany.mockImplementation(async () => []);
  mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => []);
});

describe('🔴 the two streams are UNIONED, not deduplicated', () => {
  it('an on-site app returns BOTH its version history and its listing revisions', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => onsiteListing());
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => [
      blockReq({
        id: 'pubreq_v2',
        version: '2.0.0',
        submittedAt: new Date('2026-06-10T00:00:00Z'),
        deployState: 'live',
      }),
      blockReq({
        id: 'pubreq_v1',
        version: '1.0.0',
        submittedAt: new Date('2026-02-02T00:00:00Z'),
      }),
    ]);
    mockDb.appListingPublishRequest.findMany.mockImplementation(async () => [
      listingReq({
        id: 'alpr_edit',
        status: 'pending',
        submittedAt: new Date('2026-07-15T00:00:00Z'),
        changelog: 'new cover',
      }),
    ]);

    const out = await listListingHistory({ appListingId: 'apl_main', userId: OWNER });

    // Three DISTINCT events — one per row across the two tables. A dedup step would
    // collapse the on-site listing-revision into a version row and lose a real edit.
    expect(out.map((e) => e.id)).toEqual(['alpr_edit', 'pubreq_v2', 'pubreq_v1']);
    expect(out.map((e) => e.source)).toEqual(['listing', 'version', 'version']);
    // Each stream keeps the fields only it has.
    expect(out[0]).toMatchObject({ version: null, changelog: 'new cover', deployState: null });
    expect(out[1]).toMatchObject({ version: '2.0.0', changelog: null, deployState: 'live' });
  });

  it('newest-first across BOTH tables, not table-by-table', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => onsiteListing());
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => [
      blockReq({ id: 'b_new', submittedAt: new Date('2026-08-01T00:00:00Z') }),
      blockReq({ id: 'b_old', submittedAt: new Date('2026-01-01T00:00:00Z') }),
    ]);
    mockDb.appListingPublishRequest.findMany.mockImplementation(async () => [
      listingReq({ id: 'l_mid', submittedAt: new Date('2026-04-01T00:00:00Z') }),
    ]);
    const out = await listListingHistory({ appListingId: 'apl_main', userId: OWNER });
    // Interleaved: if the two lists were concatenated without a merge sort this would be
    // ['l_mid','b_new','b_old'].
    expect(out.map((e) => e.id)).toEqual(['b_new', 'l_mid', 'b_old']);
  });

  it('a same-instant tie is broken deterministically rather than left to insertion order', async () => {
    const t = new Date('2026-03-03T03:03:03Z');
    mockDb.appListing.findUnique.mockImplementation(async () => onsiteListing());
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => [
      blockReq({ id: 'aaa', submittedAt: t }),
    ]);
    mockDb.appListingPublishRequest.findMany.mockImplementation(async () => [
      listingReq({ id: 'zzz', submittedAt: t }),
    ]);
    const out = await listListingHistory({ appListingId: 'apl_main', userId: OWNER });
    expect(out.map((e) => e.id)).toEqual(['zzz', 'aaa']);
  });
});

describe('🔴 the block query is CONDITIONAL on the block, not on the kind', () => {
  it('an off-site listing never queries the block table at all', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => offsiteListing());
    mockDb.appListingPublishRequest.findMany.mockImplementation(async () => [
      listingReq({ id: 'alpr_only' }),
    ]);
    const out = await listListingHistory({ appListingId: 'apl_ext', userId: OWNER });
    expect(out.map((e) => e.id)).toEqual(['alpr_only']);
    // 🔴 Issuing it with a null id would match every request whose block FK is still
    // unset — i.e. every OTHER app's pending first version — and hand them to this caller.
    expect(mockDb.appBlockPublishRequest.findMany).not.toHaveBeenCalled();
  });

  it('the block query names THIS app’s block id, alongside the null-FK slug branch', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () =>
      onsiteListing({
        appBlockId: 'ab_specific',
        slug: 'specific-app',
        appBlock: { app: { userId: OWNER } },
      })
    );
    await listListingHistory({ appListingId: 'apl_main', userId: OWNER });
    const call = mockDb.appBlockPublishRequest.findMany.mock.calls[0][0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    // Both branches, and nothing else: the FK finds every approved-era request, the
    // owner-scoped slug finds the pre-approval ones whose FK is still NULL.
    expect(call.where.OR).toEqual([
      { appBlockId: 'ab_specific' },
      { slug: 'specific-app', submittedByUserId: OWNER },
    ]);
  });
});

describe('🔴 shadow revisions are folded in', () => {
  it('the listing query asks for the parent AND its shadows', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => offsiteListing());
    await listListingHistory({ appListingId: 'apl_ext', userId: OWNER });
    const call = mockDb.appListingPublishRequest.findMany.mock.calls[0][0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    // A revision request targets a HIDDEN shadow whose `revisionOfId` is the parent, so a
    // query keyed on `appListingId` alone would miss every edit the author ever made.
    expect(call.where.OR).toEqual([
      { appListingId: 'apl_ext' },
      { appListing: { revisionOfId: 'apl_ext' } },
    ]);
  });

  it('a SHADOW id resolves to its parent before anything is queried', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => ({
      id: 'apl_shadow',
      userId: OWNER,
      kind: 'offsite',
      appBlockId: null,
      revisionOfId: 'apl_parent',
      appBlock: null,
      revisionOf: {
        id: 'apl_parent',
        userId: OWNER,
        kind: 'offsite',
        appBlockId: null,
        appBlock: null,
      },
    }));
    await listListingHistory({ appListingId: 'apl_shadow', userId: OWNER });
    const call = mockDb.appListingPublishRequest.findMany.mock.calls[0][0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    expect(call.where.OR[0]).toEqual({ appListingId: 'apl_parent' });
  });
});

describe('🔴 authorization is ownership∪seat, NEVER submittedByUserId', () => {
  /**
   * 🔴 THE DISTINCTION THAT MATTERS IS *WHOSE* ID APPEARS, not whether the column does.
   * The null-FK slug branch legitimately carries `submittedByUserId` — scoped to the
   * listing's OWNER, so a recycled slug cannot leak a stranger's review. Scoping to the
   * VIEWER is the bug: that is what empties the history for a collaborator, a transfer
   * recipient and a moderator-claimed owner. This asserts against a SEAT-HOLDER, where the
   * two ids differ, so a mutant that swapped owner for viewer dies here.
   */
  it('the queries name the OWNER, never the viewer', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => onsiteListing());
    mockDb.appCollaborator.findFirst.mockImplementation(async () => ({ userId: SEAT }));
    await listListingHistory({ appListingId: 'apl_main', userId: SEAT });
    const listingWhere = JSON.stringify(
      (mockDb.appListingPublishRequest.findMany.mock.calls[0][0] as { where: unknown }).where
    );
    const blockWhere = JSON.stringify(
      (mockDb.appBlockPublishRequest.findMany.mock.calls[0][0] as { where: unknown }).where
    );
    // The LISTING stream keys on the listing id alone — no submitter column at all.
    expect(listingWhere).not.toContain('submittedByUserId');
    // The BLOCK stream's slug branch names the OWNER…
    expect(blockWhere).toContain(`"submittedByUserId":${OWNER}`);
    // …and never the caller, who here is a seat-holder who submitted nothing.
    expect(blockWhere).not.toContain(`"submittedByUserId":${SEAT}`);
  });

  it('an ACCEPTED collaborator — who submitted nothing — gets the full history', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => onsiteListing());
    mockDb.appCollaborator.findFirst.mockImplementation(async () => ({ userId: SEAT }));
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => [
      blockReq({ id: 'pubreq_by_owner' }),
    ]);
    const out = await listListingHistory({ appListingId: 'apl_main', userId: SEAT });
    expect(out.map((e) => e.id)).toEqual(['pubreq_by_owner']);
  });

  it('a stranger with no seat is refused FORBIDDEN, not handed an empty list', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => onsiteListing());
    mockDb.appCollaborator.findFirst.mockImplementation(async () => null);
    // An empty list would read to the UI as "this app has no history", which is a lie.
    await expect(
      listListingHistory({ appListingId: 'apl_main', userId: STRANGER })
    ).rejects.toThrow(/do not have access/i);
  });

  it('an unknown listing is NOT_FOUND', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => null);
    await expect(listListingHistory({ appListingId: 'apl_nope', userId: OWNER })).rejects.toThrow(
      /not found/i
    );
  });
});

describe('bounds', () => {
  it('caps the merged result at the limit even when both tables are full', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => onsiteListing());
    const many = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `${prefix}_${String(i).padStart(3, '0')}`,
        submittedAt: new Date(2026, 0, 1, 0, i),
      }));
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () =>
      many('b', LISTING_HISTORY_LIMIT).map((r) => blockReq(r))
    );
    mockDb.appListingPublishRequest.findMany.mockImplementation(async () =>
      many('l', LISTING_HISTORY_LIMIT).map((r) => listingReq(r))
    );
    const out = await listListingHistory({ appListingId: 'apl_main', userId: OWNER });
    expect(out).toHaveLength(LISTING_HISTORY_LIMIT);
  });

  it('an explicit limit above the ceiling is clamped, not honoured', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => offsiteListing());
    await listListingHistory({ appListingId: 'apl_ext', userId: OWNER, limit: 9999 });
    const call = mockDb.appListingPublishRequest.findMany.mock.calls[0][0] as { take: number };
    expect(call.take).toBe(LISTING_HISTORY_LIMIT);
  });
});

/* ------------------------------------------------------------------------ *
 * 🔴 THE NULL-FK POPULATION — `app_block_id` is NULL until approve
 * ------------------------------------------------------------------------ */

describe('🔴 blockRequestWhereForListing — the null-FK branch', () => {
  const ONSITE = { kind: 'onsite', slug: 'my-app', ownerUserId: OWNER };

  it('keys on the block id once the app is approved', () => {
    expect(blockRequestWhereForListing({ ...ONSITE, appBlockId: 'ab_9' })).toEqual({
      OR: [{ appBlockId: 'ab_9' }, { slug: 'my-app', submittedByUserId: OWNER }],
    });
  });

  /**
   * 🔴 THE WHOLE DEFECT, as one assertion. `submitApp` writes `appBlockId: null` and only
   * the approve path backfills it, so a first version has no FK — and the previous
   * implementation skipped the block query entirely on a null id. Measured on production
   * 2026-08-20: 3 of 3 rejected and 27 of 33 withdrawn rows are in this state.
   */
  it('falls back to the OWNER-SCOPED slug when the FK is still null', () => {
    expect(blockRequestWhereForListing({ ...ONSITE, appBlockId: null })).toEqual({
      slug: 'my-app',
      submittedByUserId: OWNER,
    });
  });

  /**
   * 🔴 THE OWNER SCOPE IS NOT DECORATION. A rejected/withdrawn first version DELETES its
   * draft listing to release the slug, so the same slug can later belong to someone else.
   * An unscoped slug match would hand that new owner the previous applicant's rejection
   * reason — which is why the branch carries BOTH clauses.
   */
  it('never emits a bare slug match', () => {
    const where = blockRequestWhereForListing({ ...ONSITE, appBlockId: null }) as Record<
      string,
      unknown
    >;
    expect(where).toHaveProperty('submittedByUserId', OWNER);
    expect(JSON.stringify(where)).not.toBe(JSON.stringify({ slug: 'my-app' }));
  });

  it('yields NOTHING when the owner is unknown — no unscoped fallback', () => {
    expect(
      blockRequestWhereForListing({ ...ONSITE, appBlockId: null, ownerUserId: null })
    ).toBeNull();
  });

  /**
   * 🔴 THE KIND GATE now does the job the null-FK check used to do by accident. An
   * OFF-SITE listing also has `appBlockId: null`; without this it would run a slug query
   * against the CODE stream for every external app.
   */
  it('an OFF-SITE listing never reaches the block table, FK or no FK', () => {
    expect(
      blockRequestWhereForListing({
        kind: 'offsite',
        appBlockId: null,
        slug: 's',
        ownerUserId: OWNER,
      })
    ).toBeNull();
    expect(
      blockRequestWhereForListing({
        kind: 'offsite',
        appBlockId: 'ab_x',
        slug: 's',
        ownerUserId: OWNER,
      })
    ).toBeNull();
  });
});

describe('🔴 a PENDING first version (listing exists as a draft, FK still null)', () => {
  function pendingV1Listing() {
    // The draft `AppListing` submit mints: real row, real slug, NO backing block yet.
    return onsiteListing({
      id: 'apl_draft',
      slug: 'pending-app',
      appBlockId: null,
      appBlock: null,
      userId: OWNER,
    });
  }

  it('returns the request instead of "No submissions yet for this app"', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => pendingV1Listing());
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => [
      blockReq({
        id: 'pubreq_v1_pending',
        version: '0.1.0',
        status: 'pending',
        submittedByUserId: OWNER,
        submittedAt: new Date('2026-08-18T00:00:00Z'),
      }),
    ]);
    const out = await listListingHistory({ appListingId: 'apl_draft', userId: OWNER });
    expect(out.map((e) => e.id)).toEqual(['pubreq_v1_pending']);
    expect(out[0]).toMatchObject({ source: 'version', status: 'pending', version: '0.1.0' });
  });

  it('🔴 offers Withdraw to the submitter — the control that was missing entirely', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => pendingV1Listing());
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => [
      blockReq({ id: 'pubreq_w', status: 'pending', submittedByUserId: OWNER }),
    ]);
    const out = await listListingHistory({ appListingId: 'apl_draft', userId: OWNER });
    expect(out[0].canWithdraw).toBe(true);
  });

  it('the query it issues is the owner-scoped slug, not a null appBlockId', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => pendingV1Listing());
    await listListingHistory({ appListingId: 'apl_draft', userId: OWNER });
    const call = mockDb.appBlockPublishRequest.findMany.mock.calls[0][0] as { where: unknown };
    expect(call.where).toEqual({ slug: 'pending-app', submittedByUserId: OWNER });
  });
});

/* ------------------------------------------------------------------------ *
 * 🔴 canWithdraw — the control is only offered to someone who can use it
 * ------------------------------------------------------------------------ */

describe('🔴 canWithdraw mirrors the procs’ own submitter scope', () => {
  it('true only for a PENDING request submitted by the viewer', () => {
    expect(canWithdrawRequest('pending', SEAT, SEAT)).toBe(true);
  });

  it('false for an accepted COLLABORATOR — the proc would throw NOT_OWNED', () => {
    expect(canWithdrawRequest('pending', OWNER, SEAT)).toBe(false);
  });

  it('false once the request is no longer pending', () => {
    expect(canWithdrawRequest('approved', SEAT, SEAT)).toBe(false);
    expect(canWithdrawRequest('rejected', SEAT, SEAT)).toBe(false);
    expect(canWithdrawRequest('withdrawn', SEAT, SEAT)).toBe(false);
  });

  it('false when the submitter is unknown', () => {
    expect(canWithdrawRequest('pending', null, SEAT)).toBe(false);
  });

  it('a seat-holder reading an owner’s pending request is not offered Withdraw', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => onsiteListing());
    mockDb.appCollaborator.findFirst.mockImplementation(async () => ({ userId: SEAT }));
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => [
      blockReq({ id: 'pubreq_owner', status: 'pending', submittedByUserId: OWNER }),
    ]);
    const out = await listListingHistory({ appListingId: 'apl_main', userId: SEAT });
    expect(out[0].canWithdraw).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * 🔴 The orphan population — the listing was DELETED
 * ------------------------------------------------------------------------ */

describe('🔴 listMyOrphanedSubmissions — rejected/withdrawn v1 whose listing is gone', () => {
  const orphanRow = (over: Record<string, unknown> & { id: string; slug: string }) => ({
    version: '0.1.0',
    status: 'rejected',
    submittedAt: new Date('2026-07-07T00:00:00Z'),
    reviewedAt: new Date('2026-07-08T00:00:00Z'),
    rejectionReason: 'manifest requests a scope it never uses',
    approvalNotes: null,
    ...over,
  });

  it('surfaces a rejected first version WITH its reviewer reason', async () => {
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => [
      orphanRow({ id: 'pubreq_rej', slug: 'gone-app' }),
    ]);
    mockDb.appListing.findMany.mockImplementation(async () => []);
    const out = await listMyOrphanedSubmissions({ userId: OWNER });
    expect(out.map((r) => r.id)).toEqual(['pubreq_rej']);
    expect(out[0]).toMatchObject({
      slug: 'gone-app',
      status: 'rejected',
      rejectionReason: 'manifest requests a scope it never uses',
      canWithdraw: false,
    });
  });

  it('scopes the read to NULL-FK requests submitted by the caller', async () => {
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => []);
    await listMyOrphanedSubmissions({ userId: OWNER });
    const call = mockDb.appBlockPublishRequest.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    // 🔴 `appBlockId: null` IS the population. A request that reached approve carries its
    // FK and is reachable from its app, so it is not an orphan.
    expect(call.where).toEqual({ submittedByUserId: OWNER, appBlockId: null });
  });

  /**
   * 🔴 THE DE-DUPLICATION RULE, and it is OWNERSHIP-scoped rather than existence-scoped. A
   * pending v1 still has its draft listing, so the app-keyed table already shows it via
   * the slug branch — listing it here too would read as two submissions.
   */
  it('drops a request whose slug still resolves to a listing the caller OWNS', async () => {
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => [
      orphanRow({ id: 'pubreq_live', slug: 'still-mine', status: 'pending' }),
      orphanRow({ id: 'pubreq_dead', slug: 'long-gone' }),
    ]);
    mockDb.appListing.findMany.mockImplementation(async () => [{ slug: 'still-mine' }]);
    const out = await listMyOrphanedSubmissions({ userId: OWNER });
    expect(out.map((r) => r.id)).toEqual(['pubreq_dead']);
  });

  /**
   * 🔴 THE MIRROR CASE, and it is why the exclusion is not a bare existence check. After a
   * rejection the slug is released and someone ELSE can take it. That stranger's listing
   * must not swallow this user's own record — the exclusion query is owner-scoped, so a
   * listing they do not own simply does not come back from it.
   */
  it('KEEPS a request whose slug was later taken by someone else', async () => {
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => [
      orphanRow({ id: 'pubreq_mine', slug: 'recycled' }),
    ]);
    // The owner-scoped lookup returns nothing: the live `recycled` listing is not theirs.
    mockDb.appListing.findMany.mockImplementation(async () => []);
    const out = await listMyOrphanedSubmissions({ userId: OWNER });
    expect(out.map((r) => r.id)).toEqual(['pubreq_mine']);
    const call = mockDb.appListing.findMany.mock.calls[0][0] as {
      where: { slug: { in: string[] }; revisionOfId: null; OR: unknown[] };
    };
    expect(call.where.slug.in).toEqual(['recycled']);
    // Ownership, not existence — the branches come from `canonicalOwnerWhereBranches`.
    expect(Array.isArray(call.where.OR)).toBe(true);
    expect(call.where.OR.length).toBeGreaterThan(0);
  });

  it('a PENDING orphan (its draft create failed) still offers Withdraw', async () => {
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => [
      orphanRow({ id: 'pubreq_p', slug: 'no-draft', status: 'pending', rejectionReason: null }),
    ]);
    mockDb.appListing.findMany.mockImplementation(async () => []);
    const out = await listMyOrphanedSubmissions({ userId: OWNER });
    expect(out[0].canWithdraw).toBe(true);
  });

  it('skips the second query entirely when there is nothing to check', async () => {
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => []);
    expect(await listMyOrphanedSubmissions({ userId: OWNER })).toEqual([]);
    expect(mockDb.appListing.findMany).not.toHaveBeenCalled();
  });
});
