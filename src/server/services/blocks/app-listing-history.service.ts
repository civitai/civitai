import { TRPCError } from '@trpc/server';

import { dbRead } from '~/server/db/client';
import {
  canonicalOwnerWhereBranches,
  resolveListingAccess,
} from '~/server/services/blocks/app-access.service';

/**
 * ONE APP'S SUBMISSION HISTORY — the per-row, fetched-on-expand read behind the merged
 * `/apps/mine` table.
 *
 * ## 🔴 THERE ARE TWO PUBLISH-REQUEST TABLES AND THEY ARE NOT DUPLICATES
 *
 * `app_block_publish_requests` and `app_listing_publish_requests` BOTH carry rows for
 * on-site apps (`app_listing_publish_requests.kind` is `CHECK (kind IN
 * ('onsite','offsite'))`, and production holds 47 approved on-site rows in it). Read
 * naively that looks like one stream written twice, and a merged history would render every
 * on-site app's past twice over. It is not. Resolved by reading the WRITERS, which is the
 * only thing that settles it — "whichever table looks newer" would have picked wrong:
 *
 *   - **`app_block_publish_requests` — the CODE/VERSION stream.** Every writer is in
 *     `publish-request.service.ts` (`submitApp` / `submitVersion` / approve / reject /
 *     withdraw / the deploy-state callbacks) plus the suspend→re-queue clone in
 *     `offsite-moderation.service.ts`. A row carries `version`, `manifest`, `bundleKey`,
 *     `bundleSha256` and the `deployState` lifecycle. This is the authority for "what code
 *     did I ship, and did it build".
 *   - **`app_listing_publish_requests` — the STORE-LISTING stream.** It has exactly THREE
 *     `create` sites in the whole tree: `offsite-listing.service.ts` `submitExternalApp`
 *     (`kind: 'offsite'`), `offsite-moderation.service.ts` reset-to-pending
 *     (`kind: 'offsite'`), and `offsite-listing.service.ts` `submitListingRevision`
 *     (`kind: shadow.kind` — the ONLY writer that can emit `onsite`). So every on-site row
 *     in this table is a shadow-revision request: a change to the STORE LISTING (name,
 *     tagline, media, category) on an already-approved app. `listMySubmissions` says so in
 *     as many words: *"an onsite listing is auto-created and has NO own publish request …
 *     all onsite requests are shadow revisions, per the invariant."*
 *
 * **So the authoritative table depends on the question.** For an on-site app's VERSION
 * history it is `app_block_publish_requests`; for its LISTING-revision history it is
 * `app_listing_publish_requests`; for an off-site app there is no code, so the listing
 * table is the whole story. They are disjoint event streams over one app, which is why
 * this function UNIONS them and tags each entry with its `source` instead of deduplicating.
 * A dedup step here would silently drop real history.
 */

/** Which stream an entry came from. Rendered as the entry's "what changed" label. */
export type ListingHistorySource = 'version' | 'listing';

/** One event in an app's history, newest-first when returned. */
export type ListingHistoryEntry = {
  id: string;
  source: ListingHistorySource;
  /** `pending | approved | rejected | withdrawn`. NOTE: never `removed` — that is a
   *  LISTING status and lives on the row, not on a request. */
  status: string;
  /** Semver, on `version` entries only. `null` for a listing revision. */
  version: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  approvalNotes: string | null;
  /** Author-written note, on `listing` entries only. */
  changelog: string | null;
  /** `building | deploying | live | failed`, on `version` entries only. */
  deployState: string | null;
  deployUpdatedAt: Date | null;
  /**
   * May THIS caller withdraw this request?
   *
   * 🔴 A SERVER-COMPUTED VERDICT, not a raw `submittedByUserId` for the client to compare.
   * Both withdraw procs are SUBMITTER-scoped — `withdrawExternalRequest` and
   * `withdrawRequest` each throw NOT_OWNED unless `submittedByUserId === userId` — so an
   * accepted collaborator, a transfer recipient and a moderator-claimed owner (precisely
   * the three populations this page exists to serve) would otherwise be offered a button
   * that can only ever red-toast.
   *
   * Carrying the verdict rather than the id keeps the rule in ONE place, on the side that
   * owns it, and avoids handing a seat-holder another user's id for no consumer — the same
   * discipline `MyAppListing` applies to `connectClientId`. `false` here is not an
   * authorization boundary: the procs are still the gate and are unchanged.
   */
  canWithdraw: boolean;
};

/** Hard cap. An app with more history than this is pathological, not paginated. */
export const LISTING_HISTORY_LIMIT = 50;

/**
 * The `where` that finds an on-site listing's CODE requests — or `null` when there is no
 * code stream to look for at all.
 *
 * 🔴 `app_block_publish_requests.app_block_id` IS NULL UNTIL APPROVE. `submitApp` writes
 * `appBlockId: existingApp?.id ?? null` (`publish-request.service.ts`), and the FK is
 * backfilled only in the approve path. Keying this query on `appBlockId` ALONE therefore
 * made an entire population invisible — measured on production 2026-08-20:
 * **3 of 3 `rejected`** and **27 of 33 `withdrawn`** block requests carry a NULL FK. A
 * developer who clicked "your app was rejected" (a notification this PR repoints at
 * `/apps/mine`) landed on a page that knew nothing about it, and a pending first version
 * rendered "No submissions yet for this app." with no status and no Withdraw.
 *
 * 🔴 THE FALLBACK IS `slug`, AND IT MUST BE OWNER-SCOPED. `slug` is the identity that
 * carries a first request across its whole lifecycle (it is NOT NULL on the request and
 * `app_listings_slug_key` is unconditionally UNIQUE), so it is the only join left when the
 * FK is null. But a slug is RELEASED when a first version is rejected or withdrawn — the
 * draft listing is deleted — so the same slug can later belong to a DIFFERENT user. An
 * unscoped slug match would hand that new owner the previous applicant's rejection reason.
 * Scoping to the listing's CANONICAL OWNER (never to the viewer) closes that without
 * re-introducing the submitter-scoping bug: an accepted collaborator still sees the
 * owner's history, because the scope names the owner and not the caller.
 *
 * 🔴 GATED ON `kind === 'onsite'`, AND THAT IS A DELIBERATE BEHAVIOUR CHANGE, not a no-op.
 * For an ORDINARY off-site listing the null `appBlockId` was already keeping it out of the
 * block table, so the gate is redundant there. It is NOT redundant for the shape
 * `mapAppBlockToListing` can mint — `kind: 'offsite'` WITH a non-null `appBlockId`, which
 * `resolveListingAccess` explicitly supports and `app-access.kind-aware-owner.test.ts`
 * pins (issue #3844). On that shape the previous `appBlockId ? … : null` DID run the block
 * query; this gate now refuses it.
 *
 * That is a tightening in the right direction, and it is worth stating rather than letting
 * it look incidental: an off-site listing's backing block is a legacy artefact, not the app
 * the store presents, so surfacing its code stream would show an author a version history
 * for something they do not publish — and `capabilitiesForKind('offsite').submitVersion` is
 * `false` for exactly that reason. The read now agrees with the capability table.
 *
 * Dropping the gate also re-opens the slug query against the code stream for every external
 * app, which is the louder half of what it prevents.
 */
export function blockRequestWhereForListing(access: {
  kind: string;
  appBlockId: string | null;
  slug?: string | null;
  ownerUserId: number | null;
}): Record<string, unknown> | null {
  if (access.kind !== 'onsite') return null;
  const branches: Record<string, unknown>[] = [];
  if (access.appBlockId) branches.push({ appBlockId: access.appBlockId });
  // The null-FK branch. Both clauses are load-bearing: `slug` finds the row, the owner
  // scope is what stops a recycled slug leaking a stranger's review.
  //
  // 🔴 STATED NARROWLY, because the scope names the CURRENT owner. On a listing acquired
  // by TRANSFER or by a moderator CLAIM, pre-approval requests submitted by the PREVIOUS
  // holder still do not surface — their `submitted_by_user_id` is someone else's. That is
  // not a regression (they were unreachable before this too) and it is the conservative
  // direction, but this branch does NOT restore first-version history for those two
  // populations; it restores it for an owner who submitted it themselves.
  if (access.slug && typeof access.ownerUserId === 'number') {
    branches.push({ slug: access.slug, submittedByUserId: access.ownerUserId });
  }
  if (branches.length === 0) return null;
  return branches.length === 1 ? branches[0] : { OR: branches };
}

/**
 * Mirror of what the two withdraw procs will actually decide.
 *
 * 🔴 IT RESTATES THE PROC'S REFUSAL, it does not replace it. `withdrawRequest`
 * (`publish-request.service.ts`) and `withdrawExternalRequest`
 * (`offsite-listing.service.ts`) both refuse NOT_OWNED unless the caller IS the submitter,
 * and both refuse a non-`pending` request. Rendering a control the server will refuse is
 * how the three populations this page serves each got a button that only red-toasts.
 */
export function canWithdrawRequest(
  status: string,
  submittedByUserId: number | null | undefined,
  viewerUserId: number
): boolean {
  return status === 'pending' && submittedByUserId === viewerUserId;
}

/**
 * Every publish event for ONE listing the caller may act on, newest first.
 *
 * 🔴 AUTHORIZED THROUGH {@link resolveListingAccess}, the SAME resolver `/apps/mine`'s row
 * set and the authoring page both go through — not through `submittedByUserId`. Scoping
 * history to the submitter is the exact defect this consolidation exists to remove: a
 * collaborator submitted nothing, and an owner who acquired the app by transfer or by a
 * moderator claim did not submit its past either, so a submitter-scoped history would come
 * back empty for both of them on an app they can plainly edit.
 *
 * 🔴 SHADOW REVISIONS ARE FOLDED IN, NOT LISTED SEPARATELY. A listing-revision request
 * targets a hidden shadow (`AppListing.revisionOfId = <parent>`), so a query keyed on
 * `appListingId = <parent>` alone would miss every revision an author ever made. Both the
 * parent-keyed and the shadow-keyed branch are needed.
 */
export async function listListingHistory(opts: {
  appListingId: string;
  userId: number;
  limit?: number;
}): Promise<ListingHistoryEntry[]> {
  const limit = Math.min(Math.max(opts.limit ?? LISTING_HISTORY_LIMIT, 1), LISTING_HISTORY_LIMIT);
  const access = await resolveListingAccess(opts.appListingId, opts.userId);
  if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'App listing not found' });
  if (!access.role) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this app' });
  }
  // `resolveListingAccess` walks a shadow id to its parent, so this is always the PARENT.
  const listingId = access.seatListingId;
  const blockWhere = blockRequestWhereForListing(access);

  const [listingRequests, blockRequests] = await Promise.all([
    dbRead.appListingPublishRequest.findMany({
      where: {
        OR: [{ appListingId: listingId }, { appListing: { revisionOfId: listingId } }],
      },
      orderBy: { submittedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        status: true,
        submittedAt: true,
        submittedByUserId: true,
        reviewedAt: true,
        rejectionReason: true,
        approvalNotes: true,
        changelog: true,
      },
    }),
    blockWhere
      ? dbRead.appBlockPublishRequest.findMany({
          where: blockWhere,
          orderBy: { submittedAt: 'desc' },
          take: limit,
          select: {
            id: true,
            version: true,
            status: true,
            submittedAt: true,
            submittedByUserId: true,
            reviewedAt: true,
            rejectionReason: true,
            approvalNotes: true,
            deployState: true,
            deployUpdatedAt: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const entries: ListingHistoryEntry[] = [
    ...listingRequests.map(
      (r: {
        id: string;
        status: string;
        submittedAt: Date;
        submittedByUserId: number;
        reviewedAt: Date | null;
        rejectionReason: string | null;
        approvalNotes: string | null;
        changelog: string | null;
      }) => ({
        id: r.id,
        source: 'listing' as const,
        status: r.status,
        version: null,
        submittedAt: r.submittedAt,
        reviewedAt: r.reviewedAt,
        rejectionReason: r.rejectionReason,
        approvalNotes: r.approvalNotes,
        changelog: r.changelog,
        deployState: null,
        deployUpdatedAt: null,
        canWithdraw: canWithdrawRequest(r.status, r.submittedByUserId, opts.userId),
      })
    ),
    ...blockRequests.map(
      (r: {
        id: string;
        version: string;
        status: string;
        submittedAt: Date;
        submittedByUserId: number;
        reviewedAt: Date | null;
        rejectionReason: string | null;
        approvalNotes: string | null;
        deployState: string | null;
        deployUpdatedAt: Date | null;
      }) => ({
        id: r.id,
        source: 'version' as const,
        status: r.status,
        version: r.version,
        submittedAt: r.submittedAt,
        reviewedAt: r.reviewedAt,
        rejectionReason: r.rejectionReason,
        approvalNotes: r.approvalNotes,
        changelog: null,
        deployState: r.deployState,
        deployUpdatedAt: r.deployUpdatedAt,
        canWithdraw: canWithdrawRequest(r.status, r.submittedByUserId, opts.userId),
      })
    ),
  ];

  entries.sort((a, b) => {
    const diff = b.submittedAt.getTime() - a.submittedAt.getTime();
    // Ties are real (a reset-to-pending writes both tables in one transaction), so the id
    // tiebreak is what keeps the order stable across requests rather than nondeterministic.
    return diff !== 0 ? diff : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return entries.slice(0, limit);
}

/**
 * One submission whose LISTING NO LONGER EXISTS — rendered on `/apps/mine` as its own
 * submission-keyed group.
 */
export type OrphanedSubmission = {
  id: string;
  slug: string;
  version: string;
  status: string;
  submittedAt: Date;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  approvalNotes: string | null;
  canWithdraw: boolean;
};

/** Display bound on the orphan group. It is a tail, not a browsable archive. */
export const ORPHANED_SUBMISSIONS_LIMIT = 25;

/**
 * How many rows the DB read scans before the ownership de-dup narrows them.
 *
 * 🔴 STRICTLY GREATER THAN THE DISPLAY CAP, and the inequality is the point: the de-dup
 * runs in application code after the query and only removes rows, so scanning exactly
 * `ORPHANED_SUBMISSIONS_LIMIT` would silently return a short page whenever any of them
 * were de-duped. Bounded rather than unbounded because this is still a per-user read on an
 * indexed pair.
 */
export const ORPHAN_SCAN_LIMIT = ORPHANED_SUBMISSIONS_LIMIT * 4;

/**
 * The caller's own first-version submissions that no APP-KEYED row can ever show them.
 *
 * 🔴 WHY A SECOND, SUBMITTER-SCOPED READ EXISTS AT ALL, in a PR whose whole point is that
 * submitter-scoping is the bug. Because for THIS population there is no app to key on. A
 * first version that is rejected or withdrawn has its pre-approval DRAFT listing DELETED —
 * `deleteOnsiteDraftListingForSlug` runs in both `rejectRequest` and `withdrawRequest` — so
 * the row `/apps/mine` would hang the history off is gone, while the request itself
 * survives with its `slug`, `status`, `rejection_reason` and `submitted_by_user_id` intact.
 * Measured on production 2026-08-20: **3 of 3 rejected** and **27 of 33 withdrawn** block
 * requests are in exactly this state. Submitter-scoping is not a policy choice here; it is
 * the only identity left on the record.
 *
 * 🔴 THE DELETION IS DELIBERATELY LEFT ALONE. `app_listings_slug_key` is an UNCONDITIONAL
 * UNIQUE index, so deleting the draft is the cleanest slug release available; a partial
 * unique index cannot back a Prisma `findUnique({ where: { slug } })`, which would mean
 * auditing every slug lookup in the repo and risking a discarded listing shadowing a live
 * one. Nothing is lost by the deletion — the record survives, it just had no reader. This
 * function is the reader. **No schema change, no migration.**
 *
 * 🔴 A REQUEST IS EXCLUDED WHEN ITS SLUG RESOLVES TO A LISTING THE CALLER OWNS, because
 * then the app-keyed table already shows it (via the null-FK slug branch in
 * {@link blockRequestWhereForListing}) and listing it twice would read as two submissions.
 * The exclusion is OWNERSHIP-scoped rather than mere existence: after a rejection the slug
 * can be taken by SOMEONE ELSE, and that stranger's listing must not swallow this user's
 * own record. Ownership is resolved with {@link canonicalOwnerWhereBranches} — the same
 * decomposition `resolveAccessibleListingIds` uses — so this cannot disagree with the set
 * the table renders. A seat-holder never reaches these rows: the read is submitter-scoped,
 * and whoever submitted a first version was its owner at the time.
 */
export async function listMyOrphanedSubmissions(opts: {
  userId: number;
}): Promise<OrphanedSubmission[]> {
  const rows = await dbRead.appBlockPublishRequest.findMany({
    // 🔴 `appBlockId: null` IS THE WHOLE POPULATION FILTER. A request that ever reached
    // approve carries its FK, so it is reachable from its app and is not an orphan. This
    // is the same NULL that made the population invisible in the first place — here it is
    // the thing being selected FOR rather than silently excluded.
    where: { submittedByUserId: opts.userId, appBlockId: null },
    orderBy: { submittedAt: 'desc' },
    // 🔴 SCAN WIDER THAN THE DISPLAY CAP, because the ownership de-dup below runs AFTER
    // this query and can only REMOVE rows. Taking the cap here would return fewer than the
    // cap while more orphans existed — an under-full page that reads as the whole truth,
    // on the one surface this population has.
    take: ORPHAN_SCAN_LIMIT,
    select: {
      id: true,
      slug: true,
      version: true,
      status: true,
      submittedAt: true,
      reviewedAt: true,
      rejectionReason: true,
      approvalNotes: true,
    },
  });
  if (rows.length === 0) return [];

  const slugs = [...new Set(rows.map((r: { slug: string }) => r.slug))];
  const ownedWithSlug = await dbRead.appListing.findMany({
    where: {
      slug: { in: slugs },
      revisionOfId: null,
      OR: canonicalOwnerWhereBranches(opts.userId),
    },
    select: { slug: true },
  });
  const ownedSlugs = new Set(ownedWithSlug.map((l: { slug: string }) => l.slug));

  return (
    rows
      .filter((r: { slug: string }) => !ownedSlugs.has(r.slug))
      // The display cap is applied HERE, after the de-dup — see {@link ORPHAN_SCAN_LIMIT}.
      .slice(0, ORPHANED_SUBMISSIONS_LIMIT)
      .map(
        (r: {
          id: string;
          slug: string;
          version: string;
          status: string;
          submittedAt: Date;
          reviewedAt: Date | null;
          rejectionReason: string | null;
          approvalNotes: string | null;
        }) => ({
          id: r.id,
          slug: r.slug,
          version: r.version,
          status: r.status,
          submittedAt: r.submittedAt,
          reviewedAt: r.reviewedAt,
          rejectionReason: r.rejectionReason,
          approvalNotes: r.approvalNotes,
          // Always the submitter here, by construction — but routed through the SAME helper
          // the app-keyed entries use, so the pending-only half of the rule has one home.
          canWithdraw: canWithdrawRequest(r.status, opts.userId, opts.userId),
        })
      )
  );
}
