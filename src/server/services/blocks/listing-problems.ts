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

export type ListingProblem = { code: ListingProblemCode; label: string };

export type ListingProblemsResult = { problems: ListingProblem[] };

/** Map the shared asset-gate `missing` codes → this surface's codes + labels. */
const ASSET_PROBLEM: Record<MissingAsset, ListingProblem> = {
  icon: { code: 'missing-icon', label: 'Missing icon' },
  cover: { code: 'missing-cover', label: 'Missing cover image' },
  screenshots: { code: 'no-screenshots', label: 'No screenshots' },
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
    problems.push({ code: 'empty-description', label: 'Missing description' });
  if (isEmpty(listing.tagline))
    problems.push({ code: 'empty-tagline', label: 'Missing tagline' });
  if (isEmpty(listing.category))
    problems.push({ code: 'empty-category', label: 'Missing category' });

  return { problems };
}
