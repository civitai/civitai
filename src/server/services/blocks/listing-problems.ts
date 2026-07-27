import {
  checkListingAssetsComplete,
  type MissingAsset,
} from '~/server/services/blocks/app-listing-assets.service';

/**
 * Advisory "listing completeness" surface for /apps/my-submissions.
 *
 * PURE + unit-tested. Given the subset of an `AppListing`'s asset ids + key text
 * fields, it enumerates the row's PROBLEMS — missing assets (icon / cover /
 * screenshots, delegated to the shared {@link checkListingAssetsComplete} gate)
 * PLUS empty key fields (description / tagline / category). `name` is always
 * filled from the manifest so it is intentionally NOT checked.
 *
 * This is a heads-up for the developer, NOT a hard gate — nothing here blocks
 * publish/approve; it only drives the warning icon + popover on the submissions
 * list. Both the on-site (`listMyPublishRequests`) and off-site
 * (`listMySubmissions`) procs project the needed fields and call this per row.
 */

/** The scan state of a single ATTACHED asset — feeds the scan dimension below. */
export type ListingAssetScan = {
  kind: 'icon' | 'cover' | 'screenshot';
  /** `scanned` (clean), `pending` (still scanning), `blocked` (prohibited content). */
  status: 'scanned' | 'pending' | 'blocked';
};

export type ListingProblemInput = {
  /** Image FK for the listing icon (null ⇒ missing). */
  iconId: number | null;
  /** Image FK for the listing cover (null ⇒ missing). */
  coverId: number | null;
  /** Number of screenshot rows (0 ⇒ a problem). */
  screenshotCount: number;
  /** Free-text description (null / whitespace-only ⇒ a problem). */
  description: string | null;
  /** Short tagline (null / whitespace-only ⇒ a problem). */
  tagline: string | null;
  /** Marketplace category (null / whitespace-only ⇒ a problem). */
  category: string | null;
  /**
   * Optional per-asset scan states (from the assets' `ingestion`). When provided, a
   * `blocked` asset becomes a BLOCKING problem ("Replace the blocked <asset> before
   * it can publish") and a `pending` asset becomes an ADVISORY heads-up ("Media
   * still scanning"). Omitting it (the default) yields NO scan problems — the pre-
   * scan-dimension behavior, so existing callers are unchanged.
   */
  assetScans?: ListingAssetScan[];
};

export type ListingProblemCode =
  | 'missing-icon'
  | 'missing-cover'
  | 'no-screenshots'
  | 'empty-description'
  | 'empty-tagline'
  | 'empty-category'
  | 'blocked-media'
  | 'scanning-media';

/**
 * A problem's severity relative to the publish FLOOR (icon + cover):
 *   - `blocking`  — below the floor; the listing CANNOT publish until fixed
 *                   (missing icon / cover).
 *   - `advisory`  — recommended but optional; does NOT block publish (missing
 *                   screenshots, empty description / tagline / category).
 */
export type ListingProblemSeverity = 'blocking' | 'advisory';

export type ListingProblem = {
  code: ListingProblemCode;
  label: string;
  severity: ListingProblemSeverity;
};

export type ListingProblemsResult = { problems: ListingProblem[] };

/**
 * Map the shared asset-gate `missing` codes → this surface's codes + labels.
 * icon/cover are the publish FLOOR → `blocking` ("required before publishing");
 * screenshots are optional → `advisory` ("recommended").
 */
const ASSET_PROBLEM: Record<MissingAsset, ListingProblem> = {
  icon: { code: 'missing-icon', label: 'Missing icon (required before publishing)', severity: 'blocking' },
  cover: {
    code: 'missing-cover',
    label: 'Missing cover image (required before publishing)',
    severity: 'blocking',
  },
  screenshots: {
    code: 'no-screenshots',
    label: 'No screenshots (recommended, optional)',
    severity: 'advisory',
  },
};

/** A value is "empty" when it's null/undefined or trims to the empty string. */
function isEmpty(value: string | null | undefined): boolean {
  return value == null || value.trim().length === 0;
}

/**
 * Enumerate a listing's advisory problems. Never throws. Order is stable:
 * assets first (icon → cover → screenshots, from the shared gate), then the
 * empty text fields (description → tagline → category). An all-complete listing
 * returns `{ problems: [] }`.
 */
export function computeListingProblems(listing: ListingProblemInput): ListingProblemsResult {
  const problems: ListingProblem[] = [];

  // Reuse the authoritative asset-completeness gate for icon/cover/screenshots.
  const assets = checkListingAssetsComplete({
    iconId: listing.iconId,
    coverId: listing.coverId,
    screenshotCount: listing.screenshotCount,
  });
  if (!assets.complete) {
    for (const missing of assets.missing) problems.push(ASSET_PROBLEM[missing]);
  }

  if (isEmpty(listing.description))
    problems.push({ code: 'empty-description', label: 'Missing description', severity: 'advisory' });
  if (isEmpty(listing.tagline))
    problems.push({ code: 'empty-tagline', label: 'Missing tagline', severity: 'advisory' });
  if (isEmpty(listing.category))
    problems.push({ code: 'empty-category', label: 'Missing category', severity: 'advisory' });

  // Scan dimension (Item 1): a still-`pending` asset is advisory (it will resolve);
  // a `blocked` asset is BLOCKING — the listing can't go live until it's replaced
  // (the go-live `assertAssetsScanClean` gate would reject it). Deduped by asset
  // KIND so N blocked screenshots yield one problem, and blocked wins over pending
  // for the same kind. Ordered blocked-first (higher severity), then pending.
  const scans = listing.assetScans ?? [];
  const blockedKinds = new Set<ListingAssetScan['kind']>();
  const pendingKinds = new Set<ListingAssetScan['kind']>();
  for (const s of scans) {
    if (s.status === 'blocked') blockedKinds.add(s.kind);
    else if (s.status === 'pending') pendingKinds.add(s.kind);
  }
  for (const kind of pendingKinds) if (blockedKinds.has(kind)) pendingKinds.delete(kind);
  for (const kind of blockedKinds)
    problems.push({
      code: 'blocked-media',
      label: `Replace the blocked ${kind} before it can publish`,
      severity: 'blocking',
    });
  for (const kind of pendingKinds)
    problems.push({
      code: 'scanning-media',
      label: `${kind[0].toUpperCase()}${kind.slice(1)} is still being scanned`,
      severity: 'advisory',
    });

  return { problems };
}
