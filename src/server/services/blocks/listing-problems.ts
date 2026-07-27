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
};

export type ListingProblemCode =
  | 'missing-icon'
  | 'missing-cover'
  | 'no-screenshots'
  | 'empty-description'
  | 'empty-tagline'
  | 'empty-category';

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

  return { problems };
}
