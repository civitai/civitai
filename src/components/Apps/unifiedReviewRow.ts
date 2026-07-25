import type { AnyRequest } from '~/components/Apps/OnsiteReviewModal';
import type { OffsitePendingRow } from '~/components/Apps/OffsiteReviewQueue';

/**
 * Pure adapters + merge for the UNIFIED moderator review lists (/apps/review).
 *
 * The Pending / Approved / Rejected tabs each render ONE list that interleaves
 * two independent sources:
 *   - on-site (App Block) publish requests   → `blocks.list{Pending,Approved,Rejected}Requests`
 *   - off-site (external listing) requests    → `appListings.list{Pending,Approved,Rejected}Requests`
 *
 * Everything here is SERVER-GRAPH-FREE and side-effect-free so it is exhaustively
 * unit-tested (`__tests__/unifiedReviewRow.test.ts`) — this is the correctness core:
 * a mis-routed or dropped row means a moderator reviews/approves the wrong thing.
 *
 * The two review MODALS are unchanged and page-owned; an adapter only wires each
 * row's `onReview` to the CORRECT one (on-site → `OnsiteReviewModal`, off-site →
 * `OffsiteReviewModal`) — the kinds never cross.
 */

export type UnifiedReviewKind = 'onsite' | 'offsite';

/** Minimal user chip carried on a unified row (rendered by the list). */
export type ReviewSubmitterChip = {
  id: number;
  username: string | null;
  image: string | null;
} | null;

export type UnifiedReviewRow = {
  /** GLOBALLY-unique dedup key across kinds — `onsite:<id>` / `offsite:<id>`.
   *  The kind prefix guarantees an on-site and an off-site request that happen to
   *  share a raw id can never collide (and so can never dedup each other away). */
  key: string;
  kind: UnifiedReviewKind;
  /** App / listing display name (falls back to the slug). */
  title: string;
  slug?: string;
  submitter: ReviewSubmitterChip;
  /** The row's ordering + display timestamp. For a PENDING row this is the
   *  submission time; for a decided (approved/rejected) HISTORY row it is the
   *  review time (so "newest-first" history sorts most-recently-reviewed first,
   *  matching the per-source server ordering). `mergeReviewRows` sorts on this. */
  submittedAt: Date;
  /** Opens the correct review modal for this row's kind. */
  onReview: () => void;
};

function toDate(d: string | Date): Date {
  return typeof d === 'string' ? new Date(d) : d;
}

/** The on-site request shape consumed by the adapter (a superset of the pending
 *  shape; history rows additionally carry `reviewedAt`). Structurally `AnyRequest`. */
export type OnsiteReviewRequest = AnyRequest;

/**
 * Map an on-site publish request → a unified row whose `onReview` opens the
 * ON-SITE modal. `title` prefers the manifest name, else the slug.
 */
export function onsiteRequestToUnifiedRow(
  req: OnsiteReviewRequest,
  openOnsiteReview: (req: OnsiteReviewRequest) => void
): UnifiedReviewRow {
  const reviewedAt =
    'reviewedAt' in req && req.reviewedAt != null ? req.reviewedAt : null;
  const manifestName =
    req.manifest && typeof req.manifest === 'object'
      ? (req.manifest as Record<string, unknown>).name
      : undefined;
  const title = typeof manifestName === 'string' && manifestName.length > 0 ? manifestName : req.slug;
  return {
    key: `onsite:${req.id}`,
    kind: 'onsite',
    title,
    slug: req.slug,
    submitter: req.submittedBy,
    submittedAt: toDate(reviewedAt ?? req.submittedAt),
    onReview: () => openOnsiteReview(req),
  };
}

/** The off-site request shape consumed by the adapter — the mod pending/history
 *  procs (`appListings.list{Pending,Approved,Rejected}Requests`) share this shape.
 *  A superset of `OffsitePendingRow`: history rows also carry `reviewedAt`. */
export type OffsiteReviewRequest = {
  id: string;
  appListingId: string | null;
  slug: string;
  status: string;
  submittedAt: string | Date;
  reviewedAt?: string | Date | null;
  changelog: string | null;
  appListing:
    | {
        name: string | null;
        externalUrl: string | null;
        category: string | null;
        contentRating: string | null;
        connectClientId?: string | null;
        connectRequestedScopes?: number | null;
        connectScopeJustifications?: Record<string, string> | null;
        connectClient?: { name: string | null } | null;
      }
    | null;
  submittedBy: { id: number; username: string | null; image: string | null } | null;
};

/**
 * Map an off-site request → a unified row whose `onReview` opens the OFF-SITE
 * modal. Builds the exact `OffsitePendingRow` the modal expects so the modal's
 * internals stay untouched. `title` prefers the listing name, else the slug.
 */
export function offsiteRequestToUnifiedRow(
  req: OffsiteReviewRequest,
  openOffsiteReview: (row: OffsitePendingRow) => void
): UnifiedReviewRow {
  const reviewedAt = req.reviewedAt != null ? req.reviewedAt : null;
  const row: OffsitePendingRow = {
    id: req.id,
    appListingId: req.appListingId,
    slug: req.slug,
    status: req.status,
    submittedAt: req.submittedAt,
    changelog: req.changelog,
    appListing: req.appListing
      ? {
          name: req.appListing.name,
          externalUrl: req.appListing.externalUrl,
          category: req.appListing.category,
          contentRating: req.appListing.contentRating,
          connectClientId: req.appListing.connectClientId ?? null,
          connectRequestedScopes: req.appListing.connectRequestedScopes ?? null,
          connectScopeJustifications: req.appListing.connectScopeJustifications ?? null,
          connectClient: req.appListing.connectClient ?? null,
        }
      : null,
    submittedBy: req.submittedBy,
  };
  return {
    key: `offsite:${req.id}`,
    kind: 'offsite',
    title: req.appListing?.name ?? req.slug,
    slug: req.slug,
    submitter: req.submittedBy,
    submittedAt: toDate(reviewedAt ?? req.submittedAt),
    onReview: () => openOffsiteReview(row),
  };
}

/**
 * Merge two already-adapted row lists into one deterministic, de-duplicated,
 * date-sorted list.
 *   - dedup by `key` (first occurrence wins; on-site keys and off-site keys are
 *     namespaced so cross-kind rows never collide — dedup is a within-kind guard);
 *   - sort by `submittedAt` — `asc` = oldest-first (pending FIFO), `desc` =
 *     newest-first (history);
 *   - STABLE, direction-independent tiebreak by `key` so equal timestamps always
 *     order identically (no render churn).
 *
 * Pure — no drops, no side effects. Every input row appears in the output exactly
 * once.
 */
export function mergeReviewRows(
  onsite: UnifiedReviewRow[],
  offsite: UnifiedReviewRow[],
  direction: 'asc' | 'desc'
): UnifiedReviewRow[] {
  const byKey = new Map<string, UnifiedReviewRow>();
  for (const row of onsite) if (!byKey.has(row.key)) byKey.set(row.key, row);
  for (const row of offsite) if (!byKey.has(row.key)) byKey.set(row.key, row);

  const rows = Array.from(byKey.values());
  rows.sort((a, b) => {
    const ta = a.submittedAt.getTime();
    const tb = b.submittedAt.getTime();
    if (ta !== tb) return direction === 'asc' ? ta - tb : tb - ta;
    // Deterministic, direction-independent tiebreak so the order is stable.
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return rows;
}
