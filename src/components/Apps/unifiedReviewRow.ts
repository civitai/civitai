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

export type UnifiedReviewKind = 'onsite' | 'offsite' | 'combined';

/**
 * The two underlying pending requests carried by a COMBINED row — an app that has
 * BOTH a pending on-site CODE request AND a pending on-site listing-MEDIA revision.
 * The combined review surface opens both sections from these payloads + ids.
 */
export type CombinedReviewPayload = {
  /** The on-site CODE publish-request id (`onsite:<id>` source). */
  onsiteRequestId: string;
  /** The on-site listing-MEDIA revision publish-request id (`onsite-listing:<id>`). */
  listingRequestId: string;
  /** The raw code request (opens the code-review section). */
  onsiteRequest: OnsiteReviewRequest;
  /** The raw listing-media row (opens the media-review section + preview). */
  listingRow: OffsitePendingRow;
};

/** Minimal user chip carried on a unified row (rendered by the list). */
export type ReviewSubmitterChip = {
  id: number;
  username: string | null;
  image: string | null;
} | null;

export type UnifiedReviewRow = {
  /** GLOBALLY-unique dedup key, namespaced by SOURCE — `onsite:<id>` (App Block
   *  code review), `offsite:<id>` (external listing review), `onsite-listing:<id>`
   *  (on-site listing-MEDIA revision). The prefix guarantees rows that happen to
   *  share a raw id can never collide (and so can never dedup each other away). */
  key: string;
  /** ROUTING kind: which review modal the row opens — `onsite` → the App Block
   *  CODE-review modal (`OnsiteReviewModal`); `offsite` → the LISTING-review modal
   *  (`OffsiteReviewModal`). An on-site listing-media revision is reviewed like the
   *  offsite listing (shadow assets + content), so it ALSO routes `offsite` — its
   *  distinct display badge is carried separately in `badge`/`badgeColor` below. */
  kind: UnifiedReviewKind;
  /** Kind-column display badge — DECOUPLED from the routing `kind` so an on-site
   *  listing-media revision (routing `offsite`) can show a "Listing media" badge
   *  distinct from an external listing's "External" badge. Adapter-controlled. */
  badge: string;
  badgeColor: string;
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
  /** Backing AppBlock id, when known (on-site CODE rows carry it) — the PRIMARY key
   *  for pairing a code row with its listing-media row; pairing falls back to `slug`
   *  when either side lacks it. Undefined for rows with no backing block. */
  appBlockId?: string | null;
  /** Raw on-site CODE request payload (set by the on-site adapter) — carried so a
   *  COMBINED row can open the code-review section from it. */
  onsiteRequest?: OnsiteReviewRequest;
  /** Raw listing row payload (set by the listing adapter) — carried so a COMBINED
   *  row can open the media-review section from it. */
  offsiteRow?: OffsitePendingRow;
  /** Present ONLY on a `kind: 'combined'` row: the two underlying request ids +
   *  payloads (code + listing-media) that the combined surface stacks. */
  combined?: CombinedReviewPayload;
  /** On-site APPROVED rows only: the build/deploy lifecycle of the approved
   *  version, so the Approved tab can show that an approval never actually
   *  shipped (and offer a re-trigger). Undefined for every other row kind. */
  deploy?: ReviewRowDeploy;
};

/** The deploy lifecycle projection carried on an on-site approved review row. */
export type ReviewRowDeploy = {
  /** `null` = never transitioned: a legacy pre-feature row, OR the STRANDED case. */
  state: string | null;
  detail: string | null;
  updatedAt: Date | null;
  /** The publish-request id — the ONLY argument `blocks.retriggerBuild` takes. */
  publishRequestId: string;
};

function toDate(d: string | Date): Date {
  return typeof d === 'string' ? new Date(d) : d;
}

function toOptionalDate(d: string | Date | null | undefined): Date | null {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  return Number.isFinite(date.getTime()) ? date : null;
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
  // Approved rows carry the deploy lifecycle (added to `listApprovedRequests`);
  // pending/rejected rows do not, so `deploy` stays undefined and every existing
  // caller/fixture is unaffected.
  const deploy: ReviewRowDeploy | undefined =
    'deployState' in req
      ? {
          state: (req as { deployState?: string | null }).deployState ?? null,
          detail: (req as { deployDetail?: string | null }).deployDetail ?? null,
          updatedAt: toOptionalDate((req as { deployUpdatedAt?: string | Date | null }).deployUpdatedAt),
          publishRequestId: req.id,
        }
      : undefined;
  return {
    key: `onsite:${req.id}`,
    kind: 'onsite',
    badge: 'App',
    badgeColor: 'blue',
    title,
    slug: req.slug,
    submitter: req.submittedBy,
    submittedAt: toDate(reviewedAt ?? req.submittedAt),
    onReview: () => openOnsiteReview(req),
    // Carried for code+media pairing + the combined surface.
    appBlockId: req.appBlockId,
    onsiteRequest: req,
    deploy,
  };
}

/** The off-site request shape consumed by the adapter — the mod pending/history
 *  procs (`appListings.list{Pending,Approved,Rejected}Requests`) share this shape.
 *  A superset of `OffsitePendingRow`: history rows also carry `reviewedAt`. */
export type OffsiteReviewRequest = {
  id: string;
  /** The listing-revision SOURCE kind carried by each row (widened in the
   *  server queue procs): `'offsite'` = an external-link/connect listing revision;
   *  `'onsite'` = an on-site listing-MEDIA revision (shadow assets changed on a
   *  first-class on-site app). BOTH are reviewed by the same listing modal, but an
   *  on-site row gets a distinct "Listing media" badge + a cap-at-app-rating review.
   *  Absent (older payloads / pre-widening) → treated as `'offsite'`. */
  kind?: 'onsite' | 'offsite';
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
 * Map a LISTING-review request → a unified row whose `onReview` opens the LISTING
 * modal (`OffsiteReviewModal`). Handles BOTH listing sub-kinds — an external-link/
 * connect listing (`kind: 'offsite'`) and an on-site listing-MEDIA revision
 * (`kind: 'onsite'`) — because both are reviewed by the same shadow-asset + content
 * modal. Only the DISPLAY badge and the dedup KEY namespace differ by sub-kind
 * (routing is identical); the modal itself renders kind-aware from `row.kind`.
 * Builds the exact `OffsitePendingRow` the modal expects so its internals stay
 * untouched. `title` prefers the listing name, else the slug.
 */
export function offsiteRequestToUnifiedRow(
  req: OffsiteReviewRequest,
  openOffsiteReview: (row: OffsitePendingRow) => void
): UnifiedReviewRow {
  const reviewedAt = req.reviewedAt != null ? req.reviewedAt : null;
  // Row is an on-site listing-media revision when the proc tags it `kind: 'onsite'`;
  // absent/`'offsite'` is the external-link/connect listing (backward-compatible).
  const isOnsiteListing = req.kind === 'onsite';
  const row: OffsitePendingRow = {
    id: req.id,
    kind: req.kind ?? 'offsite',
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
    // Distinct key namespace per sub-kind so an on-site listing-media row and an
    // external listing row can never dedup each other away.
    key: isOnsiteListing ? `onsite-listing:${req.id}` : `offsite:${req.id}`,
    // Routing kind is `offsite` for BOTH (they open the same listing modal).
    kind: 'offsite',
    badge: isOnsiteListing ? 'Listing media' : 'External',
    badgeColor: isOnsiteListing ? 'teal' : 'grape',
    title: req.appListing?.name ?? req.slug,
    slug: req.slug,
    submitter: req.submittedBy,
    submittedAt: toDate(reviewedAt ?? req.submittedAt),
    onReview: () => openOffsiteReview(row),
    // Carried so a COMBINED row can open the media-review section from this payload.
    // (The listing queue row has no backing appBlockId; pairing falls back to slug.)
    offsiteRow: row,
  };
}

/** Do two rows belong to the SAME app? Prefer a backing-block match; fall back to
 *  slug (a listing-media row carries no appBlockId, so code+media pairs match on
 *  slug — the same app slug on both sides). */
function sameApp(a: UnifiedReviewRow, b: UnifiedReviewRow): boolean {
  if (a.appBlockId && b.appBlockId) return a.appBlockId === b.appBlockId;
  return !!a.slug && a.slug === b.slug;
}

/**
 * Collapse an on-site CODE row + an on-site listing-MEDIA row for the SAME app into
 * ONE combined row carrying both request ids + payloads. ONLY these two kinds
 * combine — an external/offsite listing (no separate code request) and an app with
 * just one of the two are left untouched. Pure: given the deduped rows + a combined
 * opener, returns a new row list with each matched pair replaced by a combined row
 * (order of first appearance preserved for the pre-sort list).
 */
function combineCodeAndMediaRows(
  rows: UnifiedReviewRow[],
  openCombined: (payload: CombinedReviewPayload) => void
): UnifiedReviewRow[] {
  const codeRows = rows.filter((r) => r.kind === 'onsite' && r.onsiteRequest);
  const mediaRows = rows.filter((r) => r.key.startsWith('onsite-listing:') && r.offsiteRow);
  const consumedMedia = new Set<string>();
  const combinedByCodeKey = new Map<string, UnifiedReviewRow>();

  for (const code of codeRows) {
    const media = mediaRows.find((m) => !consumedMedia.has(m.key) && sameApp(code, m));
    if (!media || !code.onsiteRequest || !media.offsiteRow) continue;
    consumedMedia.add(media.key);
    const payload: CombinedReviewPayload = {
      onsiteRequestId: code.onsiteRequest.id,
      listingRequestId: media.offsiteRow.id,
      onsiteRequest: code.onsiteRequest,
      listingRow: media.offsiteRow,
    };
    combinedByCodeKey.set(code.key, {
      // Deterministic, unique key from BOTH child keys.
      key: `combined:${code.key}+${media.key}`,
      kind: 'combined',
      badge: 'App + media',
      badgeColor: 'indigo',
      title: code.title,
      slug: code.slug,
      submitter: code.submitter,
      // Sort by the EARLIER of the two so the pair surfaces by when the app first
      // needed review (oldest-first pending); tiebreak by key stays stable.
      submittedAt: new Date(
        Math.min(code.submittedAt.getTime(), media.submittedAt.getTime())
      ),
      appBlockId: code.appBlockId ?? media.appBlockId,
      onReview: () => openCombined(payload),
      combined: payload,
    });
  }

  if (combinedByCodeKey.size === 0) return rows;

  // Rebuild: replace each matched code row with its combined row (in place, so
  // ordering is stable) and drop the consumed media rows.
  const out: UnifiedReviewRow[] = [];
  for (const r of rows) {
    if (r.kind === 'onsite' && combinedByCodeKey.has(r.key)) {
      out.push(combinedByCodeKey.get(r.key)!);
      continue;
    }
    if (r.key.startsWith('onsite-listing:') && consumedMedia.has(r.key)) continue;
    out.push(r);
  }
  return out;
}

/**
 * Merge two already-adapted row lists into one deterministic, de-duplicated,
 * date-sorted list.
 *   - dedup by `key` (first occurrence wins; on-site keys and off-site keys are
 *     namespaced so cross-kind rows never collide — dedup is a within-kind guard);
 *   - when `openCombined` is provided (the PENDING queue), collapse an on-site CODE
 *     row + an on-site listing-MEDIA row for the SAME app into ONE combined row
 *     carrying both ids/payloads (see `combineCodeAndMediaRows`). History tabs omit
 *     the opener, so decided rows are never combined;
 *   - sort by `submittedAt` — `asc` = oldest-first (pending FIFO), `desc` =
 *     newest-first (history);
 *   - STABLE, direction-independent tiebreak by `key` so equal timestamps always
 *     order identically (no render churn).
 *
 * Pure — no side effects. Every input row appears in the output exactly once, EXCEPT
 * a combined code+media pair, which appears as its single combined row.
 */
export function mergeReviewRows(
  onsite: UnifiedReviewRow[],
  offsite: UnifiedReviewRow[],
  direction: 'asc' | 'desc',
  openCombined?: (payload: CombinedReviewPayload) => void
): UnifiedReviewRow[] {
  const byKey = new Map<string, UnifiedReviewRow>();
  for (const row of onsite) if (!byKey.has(row.key)) byKey.set(row.key, row);
  for (const row of offsite) if (!byKey.has(row.key)) byKey.set(row.key, row);

  let rows = Array.from(byKey.values());
  if (openCombined) rows = combineCodeAndMediaRows(rows, openCombined);

  rows.sort((a, b) => {
    const ta = a.submittedAt.getTime();
    const tb = b.submittedAt.getTime();
    if (ta !== tb) return direction === 'asc' ? ta - tb : tb - ta;
    // Deterministic, direction-independent tiebreak so the order is stable.
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return rows;
}
