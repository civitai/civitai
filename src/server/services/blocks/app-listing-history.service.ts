import { TRPCError } from '@trpc/server';

import { dbRead } from '~/server/db/client';
import { resolveListingAccess } from '~/server/services/blocks/app-access.service';

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
};

/** Hard cap. An app with more history than this is pathological, not paginated. */
export const LISTING_HISTORY_LIMIT = 50;

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
  const appBlockId = access.appBlockId;

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
        reviewedAt: true,
        rejectionReason: true,
        approvalNotes: true,
        changelog: true,
      },
    }),
    // 🔴 CONDITIONAL, and the condition is the block — not the kind. An off-site listing
    // has no `appBlockId`, so there is no code stream to read; issuing the query with a
    // `null` id would match every request whose block FK is still unset (a pending FIRST
    // version, for ANY app) and hand this caller other people's submissions.
    appBlockId
      ? dbRead.appBlockPublishRequest.findMany({
          where: { appBlockId },
          orderBy: { submittedAt: 'desc' },
          take: limit,
          select: {
            id: true,
            version: true,
            status: true,
            submittedAt: true,
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
      })
    ),
    ...blockRequests.map(
      (r: {
        id: string;
        version: string;
        status: string;
        submittedAt: Date;
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
