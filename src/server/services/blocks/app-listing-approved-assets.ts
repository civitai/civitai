import type { Prisma } from '@prisma/client';

/**
 * App Store Listings — "are this listing's assets the ones a moderator approved?"
 *
 * 🔴 THE PROBLEM THIS EXISTS TO SOLVE. An owner may `unpublishOwnListing` their own
 * approved listing (approved → removed) and then republish it. A `removed` listing is
 * DIRECTLY asset-editable — `assertOwnerAssetEditable` refuses only an `approved`,
 * non-shadow row — so between those two actions the owner can swap the icon, the cover
 * and every screenshot. `republishOwnListing`'s existing go-live gates do not see it:
 * `assertListingAssetsScanCleanInTx` reads scan STATUS, `assertOffsiteListingActionableInTx`
 * reads the destination href, and the #4418 rating floor reads MATURITY. None of them is
 * a content review, so brand-new store-card imagery could reach the public store with no
 * human ever looking at it.
 *
 * 🔴 NOTHING IN THE SCHEMA ALREADY RECORDS THIS. Enumerated over every non-test writer of
 * `appListingModerationEvent.create` in `src/`: `delist`, `relist`, `claim`, `purge`,
 * `reset-to-pending`, `owner-unpublish`, `owner-republish`, `message-owner` and the
 * publish-request delist all write `before`/`after` payloads of the shape
 * `{ status }` / `{ userId }` / `{ recipientUserIds }` — no writer records an asset id.
 * `AppListingPublishRequest` snapshots no assets either (it carries slug/status/notes),
 * and `AppListing.updatedAt` / `AppListingScreenshot.updatedAt` are useless as a signal:
 * the republish flip itself bumps `AppListing.updatedAt`, and a DELETED screenshot row
 * leaves no timestamp behind at all. So the signal has to be RECORDED, not inferred.
 *
 * 🔴 WHERE IT IS RECORDED, AND WHY THAT INSTANT IS THE RIGHT ONE. The snapshot is written
 * into the `owner-unpublish` moderation event's `before` payload, by `unpublishOwnListing`,
 * inside the same transaction as the flip. At that instant the listing is `approved` and an
 * approved non-shadow listing is NOT owner-asset-editable, so its live assets ARE the
 * assets that were last approved (an owner's edit to an approved listing goes through a
 * shadow revision, which is moderator-reviewed before it is copied onto the parent; a
 * moderator's live curation is itself a reviewed action). "The assets at the last
 * approval" and "the assets at owner-unpublish" are therefore the same set, and the second
 * one is the one we can observe on the path that needs it.
 *
 * SIBLING, DELIBERATELY NOT SHARED: `src/components/Apps/listingRevisionDrift.ts` holds a
 * same-spirited `ListingAssetSnapshot` view-model + `computeListingRevisionDrift`. That
 * one is CLIENT-side, computed at review time from two LIVE tRPC reads to show a moderator
 * what approving a shadow revision would change; it is never persisted, and its own
 * docstring records that answering "did the baseline move?" would need a stored baseline.
 * This module IS that stored baseline, on the server, for a different question. Merging
 * them would drag a React-tree module onto the transaction path for no gain.
 *
 * 🔴 ABSENCE IS A REAL BRANCH AND IT FAILS CLOSED. {@link parseApprovedAssetSnapshot}
 * returns `null` for a missing, malformed or future-versioned payload — it never returns
 * an empty snapshot, because an empty snapshot would COMPARE EQUAL to a listing that
 * happens to have no assets and would silently read as "nothing changed". A comparison
 * against an absent operand must report MISSING, not SAME. The caller routes a `null` to
 * re-review. That is the whole population of listings unpublished BEFORE this shipped:
 * for them we genuinely cannot tell, so they get one re-review on their next republish.
 */

/**
 * The snapshot format version. BUMP IT if the shape below changes meaning, and leave
 * {@link parseApprovedAssetSnapshot} rejecting every version it does not understand — an
 * unrecognised version must degrade to "unknown" (→ re-review), never to a partial or
 * coerced comparison against a shape it was not written in.
 */
export const APPROVED_ASSET_SNAPSHOT_VERSION = 1;

/** One reviewable screenshot: the image it shows and the caption printed under it. */
export type ApprovedAssetSnapshotScreenshot = {
  imageId: number;
  caption: string | null;
};

/**
 * The reviewable asset surface of a listing: its icon, its cover, and its screenshots
 * IN DISPLAY ORDER.
 *
 * 🔴 THE SCREENSHOT ARRAY IS POSITIONAL ON PURPOSE — the row's `order` COLUMN is not
 * recorded. Renumbering the same sequence 0,1,2 → 10,20,30 changes no pixel a viewer
 * sees and must not force a re-review; genuinely RE-ORDERING two screenshots does change
 * the card and shows up as a different array. Recording the raw `order` value would
 * invert both of those. The row `id` is likewise not recorded, so removing a screenshot
 * and re-adding the identical image+caption is correctly read as unchanged.
 *
 * Captions ARE part of the surface: a caption is public text printed on the store card,
 * so swapping one is a content change even when every image is identical.
 */
export type ApprovedAssetSnapshot = {
  v: typeof APPROVED_ASSET_SNAPSHOT_VERSION;
  iconId: number | null;
  coverId: number | null;
  screenshots: ApprovedAssetSnapshotScreenshot[];
};

/** A screenshot row as read from the database, before normalisation. */
export type ListingScreenshotRow = {
  imageId: number | null;
  order: number;
  caption: string | null;
};

/**
 * Normalise a caption to its comparable form: trimmed, with blank collapsing to `null`.
 * `''`, `'   '` and `null` all render the same nothing, so they must compare equal —
 * otherwise a stray space forces a pointless re-review.
 */
function normalizeCaption(caption: string | null | undefined): string | null {
  const trimmed = (caption ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Put screenshot rows into a deterministic display order and strip everything that is not
 * part of the reviewable surface.
 *
 * 🔴 ROWS WITH NO `imageId` ARE DROPPED, not recorded as holes. Such a row displays
 * nothing, so its creation or deletion is not a content change; recording it would make
 * the gate fire on a difference no viewer can see. (It is also exactly what the go-live
 * scan gate does — `assertListingAssetsScanCleanInTx` selects `imageId: { not: null }` —
 * so the two agree on what "the listing's screenshots" means.)
 *
 * 🔴 THE SORT IS TOTAL, not just `order`. Two rows may legitimately share an `order`
 * value, and a comparator that leaves them tied would hand back whichever order the query
 * planner happened to produce — a snapshot that differs from itself between two reads,
 * which fails CLOSED but at random. `imageId` then `caption` break the tie with values
 * that are part of the content itself.
 */
export function normalizeListingScreenshots(
  rows: readonly ListingScreenshotRow[]
): ApprovedAssetSnapshotScreenshot[] {
  return rows
    .filter((r): r is ListingScreenshotRow & { imageId: number } => r.imageId != null)
    .map((r) => ({ imageId: r.imageId, order: r.order, caption: normalizeCaption(r.caption) }))
    .sort(
      (a, b) =>
        a.order - b.order ||
        a.imageId - b.imageId ||
        (a.caption ?? '').localeCompare(b.caption ?? '')
    )
    .map(({ imageId, caption }) => ({ imageId, caption }));
}

/** The narrowest client shape the snapshot reader needs — a `tx`, `dbWrite` or `dbRead`. */
export type ListingScreenshotReader = Pick<Prisma.TransactionClient, 'appListingScreenshot'>;

/**
 * Build the CURRENT asset snapshot for a listing.
 *
 * `iconId`/`coverId` are passed in rather than re-read: every caller has already loaded
 * the listing row on the primary inside its transaction, and re-reading them would open a
 * second window in which they could move relative to the screenshots.
 *
 * Pass the in-transaction `tx` at both the record site and the compare site so the
 * snapshot is row-consistent with the status flip it gates.
 */
export async function buildApprovedAssetSnapshot(
  db: ListingScreenshotReader,
  appListingId: string,
  listing: { iconId: number | null | undefined; coverId: number | null | undefined }
): Promise<ApprovedAssetSnapshot> {
  const rows = await db.appListingScreenshot.findMany({
    where: { appListingId },
    select: { imageId: true, order: true, caption: true },
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
  });
  return {
    v: APPROVED_ASSET_SNAPSHOT_VERSION,
    iconId: listing.iconId ?? null,
    coverId: listing.coverId ?? null,
    screenshots: normalizeListingScreenshots(rows),
  };
}

/** `number | null`, and nothing else — `undefined`, a string id or a float are all wrong. */
function isNullableImageId(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isInteger(value));
}

/**
 * Parse a snapshot back out of a moderation event's JSONB payload.
 *
 * 🔴 RETURNS `null` FOR ANYTHING IT DOES NOT FULLY RECOGNISE — absent, not-an-object,
 * wrong/absent version, or a screenshots array with even one malformed entry. It must
 * NEVER coerce a partial payload into a snapshot: the caller's next move is an equality
 * test, and a coerced value would compare equal to some real listing and wave it through.
 * `null` means "we do not know what was approved", which the caller turns into a review.
 */
export function parseApprovedAssetSnapshot(value: unknown): ApprovedAssetSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== APPROVED_ASSET_SNAPSHOT_VERSION) return null;
  if (!isNullableImageId(raw.iconId) || !isNullableImageId(raw.coverId)) return null;
  if (!Array.isArray(raw.screenshots)) return null;

  const screenshots: ApprovedAssetSnapshotScreenshot[] = [];
  for (const entry of raw.screenshots) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    if (typeof row.imageId !== 'number' || !Number.isInteger(row.imageId)) return null;
    if (row.caption !== null && typeof row.caption !== 'string') return null;
    screenshots.push({ imageId: row.imageId, caption: row.caption });
  }
  return {
    v: APPROVED_ASSET_SNAPSHOT_VERSION,
    iconId: raw.iconId,
    coverId: raw.coverId,
    screenshots,
  };
}

/**
 * Read the recorded asset snapshot out of a moderation event's `before` payload, or
 * `null` when the event carries none. Both arms of the absence — an event written before
 * this feature existed, and a payload that is not a snapshot — collapse to `null` here,
 * and the caller must treat `null` as UNKNOWN rather than as "no assets".
 */
export function readRecordedAssetSnapshot(
  before: Prisma.JsonValue | null | undefined
): ApprovedAssetSnapshot | null {
  if (typeof before !== 'object' || before === null || Array.isArray(before)) return null;
  return parseApprovedAssetSnapshot((before as Record<string, unknown>).assets);
}

/**
 * Structural equality over the reviewable surface. Both operands must be real snapshots;
 * "one side is unknown" is NOT an equality question and is decided by the caller before
 * it gets here (see {@link parseApprovedAssetSnapshot}).
 */
export function approvedAssetSnapshotsEqual(
  a: ApprovedAssetSnapshot,
  b: ApprovedAssetSnapshot
): boolean {
  if (a.iconId !== b.iconId) return false;
  if (a.coverId !== b.coverId) return false;
  if (a.screenshots.length !== b.screenshots.length) return false;
  for (let i = 0; i < a.screenshots.length; i++) {
    if (a.screenshots[i].imageId !== b.screenshots[i].imageId) return false;
    if (a.screenshots[i].caption !== b.screenshots[i].caption) return false;
  }
  return true;
}

/** Why an owner republish has to go back through review, or `null` when it does not. */
export type RepublishReviewReason = 'assets-changed' | 'no-recorded-assets';

/**
 * THE GATE. Decide whether an owner republish may go live immediately or must re-enter
 * the review queue.
 *
 * - no recorded snapshot → `'no-recorded-assets'` (FAIL CLOSED — we cannot tell)
 * - recorded snapshot differs from the live assets → `'assets-changed'`
 * - recorded snapshot matches → `null`, republish stays immediate exactly as before
 */
export function resolveRepublishReviewReason(
  recorded: ApprovedAssetSnapshot | null,
  live: ApprovedAssetSnapshot
): RepublishReviewReason | null {
  if (recorded === null) return 'no-recorded-assets';
  return approvedAssetSnapshotsEqual(recorded, live) ? null : 'assets-changed';
}

/** Human-readable `detail` for the audit event, so the history says WHY it re-queued. */
export const REPUBLISH_REVIEW_DETAIL: Record<RepublishReviewReason, string> = {
  'assets-changed': 'listing assets changed since the last approval — routed to review',
  'no-recorded-assets':
    'no recorded assets from the last approval to compare against — routed to review',
};
