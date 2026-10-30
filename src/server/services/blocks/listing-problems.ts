import {
  checkListingAssetsComplete,
  type MissingAsset,
} from '~/server/services/blocks/app-listing-assets.service';
import { offsiteContentRatingLabel } from '~/shared/constants/browsingLevel.constants';
import { listingAssetAudience } from '~/shared/utils/listing-media-split';
import {
  assetRating,
  MATURE_STORE_HOST,
  SFW_STORE_HOST,
  summarizeListingRating,
} from '~/shared/utils/listing-rating-display';

/**
 * Advisory "listing completeness" surface for /apps/my-submissions.
 *
 * PURE + unit-tested. Given a listing's asset ids, key text fields, scan states, status
 * and ratings, it enumerates the row's PROBLEMS — missing assets (icon / cover /
 * screenshots, delegated to the shared {@link checkListingAssetsComplete} gate), empty
 * key fields (description / tagline / category), blocked or still-scanning media, and a
 * rating raised above the declared one that hides an approved listing from the SFW store. `name` is always
 * filled from the manifest so it is intentionally NOT checked.
 *
 * This function only REPORTS; the gates are elsewhere. Its `blocking` problems mirror
 * real server gates — missing icon / cover is the publish floor (`checkListingMeetsFloor`,
 * refused by every approve that makes a listing live, on-site included), and a blocked
 * image is the scan-clean go-live gate — while `advisory` ones never block. It drives the
 * warning icon + popover on the submissions list (grouped by severity) and the listing
 * readiness a submit answers with (`submitVersion`). The on-site
 * (`listMyPublishRequests`) and off-site (`listMySubmissions`) procs project the needed
 * fields and call this per row.
 *
 * 🔴 KIND-AWARE. `empty-description` / `empty-tagline` / `empty-category` name a
 * DIFFERENT remedy on an on-site listing than on an off-site one, because on-site
 * copy has no author surface other than `block.manifest.json`. `kind` is a REQUIRED
 * input for that reason — see {@link ListingProblemInput.kind} and
 * {@link TEXT_PROBLEM}. The codes and severities are kind-INVARIANT (a released CLI
 * branches on `code`).
 */

/** The scan state of a single ATTACHED asset — feeds the scan dimension below. */
export type ListingAssetScan = {
  kind: 'icon' | 'cover' | 'screenshot';
  /** `scanned` (clean), `pending` (still scanning), `blocked` (prohibited content). */
  status: 'scanned' | 'pending' | 'blocked';
  /** The image's detected level; feeds the civitai.com media problems. Absent ⇒ none of those. */
  nsfwLevel?: number | null;
};

/**
 * Which STORE LISTING this advisory is about. `onsite` = a hosted App Block whose
 * copy is manifest-governed; `offsite` = an external-link listing whose copy the
 * author typed into the submit wizard / listing editor.
 *
 * 🔴 STRUCTURALLY IDENTICAL TO `ListingKind` (app-listing-read.schema) and
 * deliberately re-declared here rather than imported: this module is PURE and is
 * imported by `app-access.service` at the top of its import graph — see the note
 * at that import.
 *
 * 🔴 WHAT ACTUALLY CATCHES A ONE-SIDED WIDENING: the `listMine` CALL SITE in
 * `app-access.service.ts`, which passes a `ListingKind`-typed value straight into
 * this type's parameter slot. Adding a member to `ListingKind` alone is therefore a
 * `tsc` error there, under the ROOT typecheck. (An earlier version of this comment
 * claimed the pin lived in `listing-problems.kind.test.ts`; it did not — that file
 * held no assignability assertion at all. There is now a belt-and-braces one there,
 * but it sits under `src/**\/__tests__/**`, which `tsconfig.json` EXCLUDES, so it is
 * only checked by the deliberate test-typecheck pass. The call site is the load-
 * bearing half; the test is the documentation.)
 */
export type ListingProblemKind = 'onsite' | 'offsite';

export type ListingProblemInput = {
  /**
   * The listing's kind. 🔴 REQUIRED, NOT OPTIONAL-WITH-A-DEFAULT, and that is the
   * whole enforcement mechanism: the three text problems below give DIFFERENT advice
   * per kind, so a caller that forgets to thread it would silently emit the wrong
   * remedy on a whole surface. A default would fail OPEN — the exact defect this
   * function is being fixed for. Making it required turns "a caller was missed" into
   * a compile error at every one of the three call sites.
   */
  kind: ListingProblemKind;
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
  /** Lifecycle status; only an `approved` listing is in the store to be hidden from it. */
  status: string;
  /** The rating the listing row carries — what the store gates on. */
  contentRating: string | null;
  /**
   * The rating the author declared, from `declaredListingRating`; `null` when the
   * listing has no separate declaration.
   */
  declaredContentRating: string | null;
};

export type ListingProblemCode =
  | 'missing-icon'
  | 'missing-cover'
  | 'no-screenshots'
  | 'empty-description'
  | 'empty-tagline'
  | 'empty-category'
  | 'blocked-media'
  | 'scanning-media'
  | 'hidden-mature-rating'
  | 'sfw-slot-mature';

/**
 * A problem's severity relative to the publish FLOOR (icon + cover):
 *   - `blocking`  — the listing CANNOT publish until fixed (missing icon / cover,
 *                   or a blocked asset).
 *   - `advisory`  — does NOT block publish: recommended-but-optional items (missing
 *                   screenshots, empty description / tagline / category), a
 *                   still-scanning asset, and the hidden-rating notice.
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
  icon: {
    code: 'missing-icon',
    label: 'Missing icon (required before publishing)',
    severity: 'blocking',
  },
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

/**
 * The three EMPTY-TEXT problems, per listing kind — the kind-aware half of this
 * surface.
 *
 * 🔴 WHY THE LABELS DIFFER BUT THE CODES DO NOT. An on-site listing's
 * `name`/`tagline`/`description`/`category` have NO author surface other than
 * `block.manifest.json`: the `/apps/<appBlockId>/edit` Listing tab is media-only
 * ("ONSITE = ASSETS-ONLY"), and `approveRequest`'s (3b-sync) MANIFEST-GOVERNED COPY
 * RE-SYNC re-derives all four from the manifest on EVERY subsequent-version approve
 * (`publish-request.service.ts`, scoped `kind: 'onsite'`). So the off-site advice
 * — "go fill this field in" — is not merely unhelpful on an on-site listing, it is
 * WRONG: any value set some other way is reverted at the next approve. Off-site copy
 * IS author-supplied through the wizard, so its labels are the original text and must
 * stay that way.
 *
 * 🔴 THE CODES ARE A WIRE CONTRACT AND ARE UNCHANGED. `problems[]` ships over tRPC to
 * a RELEASED `@civitai/cli` (`civitai app doctor`) which branches on `code`. Renaming
 * or dropping one would break it silently, and SUPPRESSING these three on the on-site
 * arm would be the same break wearing a different hat — the CLI's on-site branch would
 * simply stop firing. Correcting the label is the only change that improves every
 * consumer without moving the contract.
 *
 * 🔴 `category` IS THE ODD ONE OUT — ITS LABEL LEADS WITH "RESUBMIT", NOT WITH THE
 * MANIFEST, AND THAT ASYMMETRY IS LOAD-BEARING. `description` and `tagline` are
 * re-derived from the manifest on every sync (`resolveListingDescription` /
 * `resolveListingTagline` in `buildListingScalarSync`), so for those two the manifest
 * genuinely IS the whole remedy. `category` is NOT: (3b-sync) sources it from
 * `AppBlock.category`, and step (3a) copies the manifest value onto that column ONLY
 * while it is still NULL, so that a moderator's curation survives a version bump.
 *
 * Enumerating every writer of `app_listings.category` for an on-site row — all THREE
 * of them — is what makes the divergence visible:
 *   1. `publish-request.service` (submit-draft, ~:1307) — FIRST-VERSION SUBMIT ONLY.
 *      Mints the pre-approval draft and is the one path that takes `category`
 *      straight off the manifest, because no `AppBlock` exists yet.
 *   2. `mapAppBlockToListing` — first approve / backfill. Reads `AppBlock.category`.
 *   3. `buildListingScalarSync` — (3b-sync), SUBSEQUENT-VERSION approve. Same source.
 *
 * 🔴 `setMarketplaceMeta` — the moderator curation path — writes `AppBlock.category`
 * and NOTHING ELSE; it never touches the listing row. So the designed curation flow
 * reaches a state this advisory cannot distinguish: author omits `category` ⇒ listing
 * minted null ⇒ moderator curates ⇒ `AppBlock.category` set, `AppListing.category`
 * STILL null ⇒ this problem fires. If the author then "sets it in the manifest",
 * (3a)'s null-gate does NOT fire, their value is DISCARDED, and (3b-sync) writes the
 * moderator's. The problem clears — but the manifest edit was inert, and an author who
 * wanted a DIFFERENT category can never get it that way.
 *
 * The problem firing is correct either way (the store card reads the listing column,
 * which genuinely has none). What was wrong was the DIAGNOSIS: the thing that always
 * clears it is an approved new version; the manifest key matters only when no category
 * is set anywhere. The label says exactly that, in that order. Pinned by
 * `listing-problems.kind.test.ts` (the whole string) and by
 * `block-registry.marketplace-meta.test.ts` (that `setMarketplaceMeta` writes only the
 * block) — if that ever changes, this wording should be revisited.
 */
const TEXT_PROBLEM: Record<
  ListingProblemKind,
  Record<'empty-description' | 'empty-tagline' | 'empty-category', string>
> = {
  offsite: {
    'empty-description': 'Missing description',
    'empty-tagline': 'Missing tagline',
    'empty-category': 'Missing category',
  },
  onsite: {
    'empty-description':
      'Missing description — set "description" in block.manifest.json and resubmit',
    'empty-tagline': 'Missing tagline — set "tagline" in block.manifest.json and resubmit',
    // 🔴 LEADS WITH THE ACTION THAT ALWAYS WORKS, and marks the manifest key
    // CONDITIONAL — see the `category` note above. A moderator-curated category lives
    // on `AppBlock.category` and reaches the listing only at the next approve, so
    // "set it in the manifest" is inert in that state while "resubmit" is not.
    'empty-category':
      'Missing category — resubmit to apply it; set "category" in block.manifest.json first if your app has none',
  },
};

/** A value is "empty" when it's null/undefined or trims to the empty string. */
function isEmpty(value: string | null | undefined): boolean {
  return value == null || value.trim().length === 0;
}

/**
 * Enumerate a listing's advisory problems. Never throws. Order is stable: assets
 * (icon → cover → screenshots, from the shared gate), empty text fields (description →
 * tagline → category), media scans (blocked, then pending), the hidden-rating notice,
 * then the civitai.com media problems (icon → cover). Returns
 * `{ problems: [] }` when none apply.
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

  // Kind-aware LABELS; codes + severities are identical across kinds (see TEXT_PROBLEM).
  //
  // 🔴 AN EXPLICIT EQUALITY BRANCH, NOT A `TEXT_PROBLEM[kind] ?? default` LOOKUP. `kind`
  // reaches us from the `app_listings.kind` COLUMN as a `string` the services CAST — it is
  // never parsed — so the index expression is effectively untrusted. Indexing a plain
  // object literal with an inherited key (`'constructor'`, `'toString'`) returns something
  // TRUTHY, which `??` happily accepts; the next lookup then yields `undefined` and the
  // author is shown a listing problem with NO label at all. Branching on equality has no
  // such hole, and it needs no `Object.create(null)` ceremony to be safe.
  //
  // 🔴 THE `else` IS A NEVER-THROWS GUARD, NOT A DEFAULT FOR CALLERS. `kind` is REQUIRED,
  // so a caller that forgets it is a COMPILE error — that is the real enforcement. This
  // branch exists so one anomalous row cannot take down the whole `/apps/mine` page,
  // breaking the header's "Never throws" contract. It degrades to the ORIGINAL, pre-kind
  // labels rather than inventing manifest advice for a listing that may not be
  // manifest-governed — the actively harmful direction, and the exact defect this
  // kind-awareness exists to fix.
  const text = listing.kind === 'onsite' ? TEXT_PROBLEM.onsite : TEXT_PROBLEM.offsite;
  if (isEmpty(listing.description))
    problems.push({
      code: 'empty-description',
      label: text['empty-description'],
      severity: 'advisory',
    });
  if (isEmpty(listing.tagline))
    problems.push({ code: 'empty-tagline', label: text['empty-tagline'], severity: 'advisory' });
  if (isEmpty(listing.category))
    problems.push({ code: 'empty-category', label: text['empty-category'], severity: 'advisory' });

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

  const hidden = hiddenMatureRatingLabel(listing);
  if (hidden) problems.push({ code: 'hidden-mature-rating', label: hidden, severity: 'advisory' });

  problems.push(...comMediaProblems(listing, scans));

  return { problems };
}

/**
 * A live listing still shown on civitai.com whose icon or cover is rated above what
 * civitai.com shows for its rating: the store there falls back past it (a placeholder icon,
 * another image as cover), and only civitai.red shows it. Advisory — the listing stays listed
 * either way. Screenshots above the rating raise nothing: they are hidden per image on
 * civitai.com and nothing stands in for them.
 */
function comMediaProblems(
  listing: ListingProblemInput,
  scans: ListingAssetScan[]
): ListingProblem[] {
  if (listing.status !== 'approved') return [];
  const { current } = summarizeListingRating({
    declaredRating: listing.declaredContentRating,
    listingRating: listing.contentRating,
  });
  if (current.hiddenOnSfw) return [];
  const redOnly = scans.filter(
    (s) => listingAssetAudience(s.nsfwLevel, listing.contentRating) === 'red-only'
  );
  const out: ListingProblem[] = [];
  for (const kind of ['icon', 'cover'] as const) {
    const asset = redOnly.find((s) => s.kind === kind);
    if (!asset) continue;
    const rating = assetRating(asset.nsfwLevel);
    out.push({
      code: 'sfw-slot-mature',
      label: `Your ${kind} is rated ${
        rating ? offsiteContentRatingLabel(rating) : 'higher'
      }, above this listing's rating, so ${SFW_STORE_HOST} shows ${
        kind === 'icon' ? 'a placeholder' : 'another image'
      } instead (${MATURE_STORE_HOST} still shows it). Replace it with an image within the listing's rating.`,
      severity: 'advisory',
    });
  }
  return out;
}

/**
 * The label for an approved listing that a rating ABOVE what its author declared hides
 * from the SFW store. A listing declared mature is hidden by the author's own choice and
 * has nothing to fix, so it is not a problem (the CLI's `app doctor` has no remedy for it).
 */
function hiddenMatureRatingLabel(listing: ListingProblemInput): string | null {
  if (listing.status !== 'approved') return null;
  const { current, declared } = summarizeListingRating({
    declaredRating: listing.declaredContentRating,
    listingRating: listing.contentRating,
  });
  if (!current.hiddenOnSfw || !current.raised || current.rating == null || declared == null)
    return null;
  return `Rated ${offsiteContentRatingLabel(
    current.rating
  )} — hidden on ${SFW_STORE_HOST} (visible on ${MATURE_STORE_HOST}). You declared ${offsiteContentRatingLabel(
    declared
  )}; a listing is rated at least as high as its most mature store image — check its images`;
}
