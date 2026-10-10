import { Prisma } from '@prisma/client';

import { getEdgeUrl } from '~/client-utils/edge-url';
import { env } from '~/env/server';
import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { toPublicBlockManifest } from '~/server/schema/blocks/subscription.schema';
import { isMatureContentRating } from '~/server/utils/server-domain';
import type { StoreVisibilityScope } from '~/server/services/app-blocks-flag';
import { narrowStoreScope } from '~/shared/utils/store-visibility-scope';
import type { ListingAudienceFloor } from '~/shared/utils/app-listing-visibility';
import {
  listingVisibleInStore,
  VISIBILITY_ELIGIBLE_LISTING_STATUSES,
  visibilitiesVisibleToForStatus,
} from '~/shared/utils/app-listing-visibility';
// The MANUAL-APPLY `visibility` column is read ONLY through this guard, which uses raw SQL:
// the field is `// @no-type` and therefore absent from the generated client entirely. See its
// module header for the production 500 that forced that.
import {
  noteDegradedVisibilityRead,
  readListingVisibility,
} from '~/server/services/blocks/app-listing-visibility.service';
import { tokenScopeMaskToList } from '~/shared/constants/token-scope.constants';
import type {
  StoreGridItem,
  GetAppListingDetailInput,
  ListAllListingsForModerationInput,
  ListAppListingsInput,
  ListingCard,
  ListingCardKindData,
  ListingCreatorChip,
  ListingDetail,
  ListingDetailKindData,
  ListingGalleryScreenshot,
  ListingKind,
  ListingRecommendRollup,
  ListingSort,
} from '~/server/schema/blocks/app-listing-read.schema';
import { listingCoverUrl, listingIconUrl } from '~/server/services/blocks/listing-media-url';
import {
  hydrateSubListingCards,
  PARENT_LINK_TEMPLATE_SQL,
} from '~/server/services/blocks/app-sub-listing-store.service';
import { isAppSubListingId } from '~/shared/constants/app-sub-listing.constants';
import { logToAxiom } from '~/server/logging/client';
// The MANUAL-APPLY `source_repo_url` column is read ONLY through this guard — never via
// `listingHydrateSelect`, which the public `/apps` GRID shares. See its module header.
import {
  isMissingColumnError,
  readListingSourceRepoUrl,
} from '~/server/services/blocks/app-listing-source-repo.service';
// The MANUAL-APPLY `is_beta` / `beta_message` columns are read ONLY through this guard —
// never via `listingHydrateSelect` or `moderationListingSelect`, for the same reason. See
// its module header.
import {
  BETA_NOT_SET,
  readListingBetaForRender,
  readListingBetaManyForRender,
  type ListingBetaRead,
} from '~/server/services/blocks/app-listing-beta.service';
import { bustCacheTag, queryCache } from '~/server/utils/cache-helpers';
// The cache TAG NAMES live in a dependency-free LEAF module, never here — a router
// that must `await import()` this service cannot name a constant exported from it
// without making that lazy import graph-inert. See that module's header.
import {
  APP_LISTING_CATALOG_TAG,
  APP_LISTING_RECOMMEND_MEAN_TAG,
} from '~/server/services/blocks/app-listing-cache.constants';
import { reviewUserChipSelect } from '~/server/selectors/review-user-chip.selector';
import type { ReviewSubmitterChip } from '~/components/Apps/unifiedReviewRow';

/**
 * App Store Listings (W13) — P2a UNIFIED STORE READ PATH service.
 *
 * Serves the unified `/apps` store over BOTH kinds (`onsite` AppBlocks +
 * `offsite` external/connect apps) from the durable `AppListing` record. This is
 * the `AppListing`-backed twin of `block-registry.service`'s
 * `listAvailable` / `getAppDetail`; it MIRRORS that path's shape (approved-only
 * WHERE, public-allowlist projection, keyset cursor pagination, Bayesian sort,
 * red-only maturity gate) but reads the new tables.
 *
 * DARK / parallel-run: nothing here is on the LIVE `/apps` surface — the UI
 * still reads the AppBlock path. These procs are wired ALONGSIDE it behind the
 * SAME mod-segmented App Blocks flag (see the router). The read-path CUTOVER +
 * its dedicated `appListings` flag are later PRs.
 *
 * TODO(W13 cutover): introduce a dedicated `appListings` Flipt flag at the
 * read-path cutover so listings can widen independently of the block runtime GA
 * (which is separately HELD). Reusing `app-blocks-enabled` here keeps P2a dark
 * without needing flipt-state creation before mods can even test.
 *
 * TODO(W13 pre-cutover): the icon/cover/screenshot URLs returned below render
 * creator-supplied imagery publicly. Two P1-audit prerequisites MUST land before
 * the flag widens to non-mods: (1) route MIGRATED bundle + AUTOGEN live-app
 * creator imagery through the real per-image NSFW ingestion scan (P1 stamped
 * them `Scanned` with an interim per-app contentRating level, which is per-app
 * not per-image); (2) decide/gate the mod-override attach-foreign-image path
 * (a private-image-exposure vector once rendered). Neither is fixed here — this
 * PR is dark and mod-only.
 */

// ---------------------------------------------------------------------------
// Sort-key encoding constants (mirror block-registry's Bayesian rating sort).
// ---------------------------------------------------------------------------

/**
 * Bayesian prior COUNT for the `top-rated` recommend sort — how many "average"
 * reviews a 0-review app is seeded with so a 1-review 100% app can't outrank a
 * many-review 95% app. (This mirrored the removed AppBlock 5-star rating sort's
 * `BAYES_MIN_REVIEWS`, which no longer exists — this constant is now the single
 * source for the store's shrinkage prior, with nothing to stay in step with.)
 */
export const LISTING_BAYES_PRIOR = 10;

// The recommend proportion is in [0,1]; scale to a zero-padded sortable integer.
// 1 * SCALE = 1_000_000 → 7 digits; pad to 9 for headroom (matches AppBlock).
const BAYES_SCORE_SCALE = 1_000_000;
const BAYES_SCORE_PAD = 9;
const INSTALL_PAD = 20; // matches the `popular` sort's install-count padding

/** Neutral fallback recommend rate when the store has no reviews yet (dark/empty). */
const DEFAULT_RECOMMEND_MEAN = 0.5;

// ---------------------------------------------------------------------------
// Keyset cursor (opaque base64url of `sortKey␟id[␟mean]`). Mirrors block-registry.
// ---------------------------------------------------------------------------

const CURSOR_SEPARATOR = String.fromCharCode(31); // unit separator (\x1f)

/**
 * Encode a keyset cursor. The `top-rated` sort PINS the global recommend mean
 * into the cursor (as the AppBlock rating sort pins its mean) so every page of a
 * paging session reuses page 1's mean — otherwise the 1h-cached mean could shift
 * mid-pagination and the keyset boundary would silently skip/duplicate a row.
 */
export function encodeListingCursor(sortKey: string, id: string, pinnedMean?: number): string {
  const body =
    pinnedMean == null
      ? `${sortKey}${CURSOR_SEPARATOR}${id}`
      : `${sortKey}${CURSOR_SEPARATOR}${id}${CURSOR_SEPARATOR}${pinnedMean}`;
  return Buffer.from(body, 'utf8').toString('base64url');
}

export function decodeListingCursor(cursor: string | undefined): {
  cursorSortKey: string | null;
  cursorId: string | null;
  cursorMean: number | null;
} {
  const empty = { cursorSortKey: null, cursorId: null, cursorMean: null };
  if (!cursor) return empty;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return empty; // malformed → treat as first page (fail-open to a safe default)
  }
  const sep1 = decoded.indexOf(CURSOR_SEPARATOR);
  if (sep1 < 0) return empty;
  const sep2 = decoded.indexOf(CURSOR_SEPARATOR, sep1 + 1);
  const cursorId = sep2 < 0 ? decoded.slice(sep1 + 1) : decoded.slice(sep1 + 1, sep2);
  const meanField = sep2 < 0 ? '' : decoded.slice(sep2 + 1);
  const meanNum = meanField === '' ? NaN : Number(meanField);
  // The mean is a recommend PROPORTION in [0,1]; a crafted cursor could encode a
  // huge/negative value that flows unclamped into `round(score * SCALE)::bigint`
  // (int8 overflow → Postgres "bigint out of range" → 500). Only accept an
  // in-range proportion; anything else is treated as an invalid mean component
  // (dropped → the caller falls back to the freshly-computed global mean /
  // first-page behavior, matching the malformed-cursor fail-open).
  const cursorMean = Number.isFinite(meanNum) && meanNum >= 0 && meanNum <= 1 ? meanNum : null;
  return {
    cursorSortKey: decoded.slice(0, sep1),
    cursorId,
    cursorMean,
  };
}

// ---------------------------------------------------------------------------
// Pure projection helpers (exported for unit tests — no DB / env / network).
// ---------------------------------------------------------------------------

/**
 * Compute the recommend rollup from an `AppListingMetric` row (or null when the
 * P5 rollup job hasn't populated one yet — every count reads 0, pct null).
 */
export function recommendRollup(
  metric: { thumbsUpCount: number; thumbsDownCount: number } | null | undefined
): ListingRecommendRollup {
  const up = metric?.thumbsUpCount ?? 0;
  const down = metric?.thumbsDownCount ?? 0;
  const total = up + down;
  return {
    recommendedCount: up,
    notRecommendedCount: down,
    recommendPct: total > 0 ? up / total : null,
  };
}

/**
 * Re-assert (defense-in-depth) that an off-site `externalUrl` is an https URL
 * before it reaches the wire — so a bad row can never surface a `javascript:` /
 * `http:` Visit target to the P2b UI, even if a write-path validation regresses.
 * NB: the P2b UI must STILL render this link with `rel="noopener noreferrer"`.
 */
function safeExternalUrl(url: string | null | undefined): string | null {
  return url && /^https:\/\//i.test(url) ? url : null;
}

/**
 * Build a CDN icon URL from an icon Image row (or null).
 *
 * Thin alias over the shared projection in `listing-media-url.ts` — the author-facing
 * `listMine` read needs the same hop, and two copies is two places to drift a width.
 */
const iconUrl = listingIconUrl;

/** Cover URL = the cover Image, else the first screenshot's Image, else null. */
const coverUrl = listingCoverUrl;

function creatorChip(
  user: { id: number; username: string | null; image: string | null } | null | undefined
): ListingCreatorChip | null {
  if (!user) return null;
  return { id: user.id, username: user.username ?? null, image: user.image ?? null };
}

/** True when the backing AppBlock manifest declares a launch page (Open vs Install). */
function manifestHasPage(manifest: unknown): boolean {
  return !!toPublicBlockManifest(manifest).hasPage;
}

/**
 * The already-public standalone origin for an ONSITE listing (no token/scope) —
 * the same `<slug>.<APPS_DOMAIN>` host the webhook validates the bundle's iframe
 * against. Shared by the card AND detail projections so their `liveUrl` for a
 * given slug can never drift. Both projections only compose this once the row
 * has passed the deploy-gate (list SQL + detail read), so the origin is live.
 */
function onsiteLiveUrl(slug: string): string {
  return `https://${slug}.${env.APPS_DOMAIN}`;
}

/**
 * The Prisma `select` for a hydrated listing row (shared by card + detail). Only
 * fields the public projection uses — the internal columns (status, ownership
 * beyond the chip, raw manifest internals) are never selected into a public DTO.
 */
export const listingHydrateSelect = {
  id: true,
  // Integer surrogate — projected into the detail DTO only (the comments thread
  // key). Harmless extra column for the card projection, which doesn't surface it.
  serialId: true,
  kind: true,
  slug: true,
  name: true,
  tagline: true,
  description: true,
  category: true,
  contentRating: true,
  externalUrl: true,
  connectClientId: true,
  // 🔴 `connectRequestedScopes` IS DELIBERATELY *NOT* HERE — it is spread in at the two
  // DETAIL call sites instead, the same pattern `status` and `revisionOfId` already use,
  // so the public `/apps` GRID this select backs is untouched.
  //
  // ⚠ An earlier draft of this PR did put it here, justified as "beside `connectClientId`,
  // which it shipped alongside in the same W13 block". That justification was FALSE and
  // the placement inherited its risk: the two columns are in DIFFERENT manual-apply
  // migrations sixteen days apart — `connect_client_id` in
  // `20260701120000_w13_p0_app_listing/`, `connect_requested_scopes` in
  // `20260717120000_w13_connect_scope_review/`, whose own header says "MANUAL APPLY … CI /
  // deploy does NOT run it" and "If that code ships before the columns exist, those
  // queries 500." Two migrations have two independent apply histories, so one column's
  // presence is no evidence about the other's. Selecting it here would have put the whole
  // public store grid behind a migration it never previously needed — the exact outcome
  // `sourceRepoUrl` records having MEASURED on a preview env ("5 smoke specs 500'd here").
  // The column IS applied in production (verified directly against `public.app_listings`);
  // that is a fact about prod, not about every environment.
  appBlockId: true,
  icon: { select: { url: true } },
  cover: { select: { url: true } },
  user: { select: { id: true, username: true, image: true } },
  // Projected into the DETAIL DTO only (the header's "Updated: <date>" meta line).
  // Harmless extra column for the card projection, which doesn't surface it.
  updatedAt: true,
  // `installCount` feeds the detail header's install stat chip. It is the SAME
  // column the public `popular` sort already orders every approved listing by
  // (`lpad(COALESCE(m.install_count, 0)…)` below), so the ordering is public
  // already — see the DTO field's allowlist justification.
  // `openCount` feeds the store CARD's play-count stat. Selected here (the shared
  // card+detail select) but projected onto the CARD only — see `cardOpenCount` and
  // the DTO field's allowlist justification. It is an aggregate over the whole
  // audience; the column is `Int NOT NULL DEFAULT 0`, so the null-vs-zero decision
  // is made in the projection, never here.
  metric: {
    select: { thumbsUpCount: true, thumbsDownCount: true, installCount: true, openCount: true },
  },
  // `currentVersionDeployedAt` powers the DEPLOY-GATE on the detail read (an
  // onsite listing whose backing block has never successfully deployed is
  // treated as unavailable). NULL ⇔ never-deployed; non-null ⇔ live (stays
  // available while a new version re-builds).
  // `approvedScopes` feeds the DETAIL DTO's pre-launch permission disclosure.
  // Projected onto the DETAIL only (see `scopes` in `projectListingDetail`); the
  // card deliberately does not carry it, for the same reason `sourceRepoUrl` is
  // detail-only — a grid tile has no room for the context that makes a
  // capability list readable.
  appBlock: { select: { manifest: true, currentVersionDeployedAt: true, approvedScopes: true } },
  screenshots: {
    where: { imageId: { not: null } },
    // Stable order: `id` tiebreaks rows with a tied `order` (default 0), which
    // would otherwise sort nondeterministically across requests.
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
    select: { caption: true, image: { select: { url: true } } },
  },
} satisfies Prisma.AppListingSelect;

export type HydratedListing = Prisma.AppListingGetPayload<{ select: typeof listingHydrateSelect }>;

/** First screenshot's CDN URL (used as the cover fallback), or null. */
function firstScreenshotUrl(row: HydratedListing): string | null {
  for (const s of row.screenshots) {
    if (s.image?.url) return getEdgeUrl(s.image.url, { width: 1200 });
  }
  return null;
}

function cardKindData(row: HydratedListing): ListingCardKindData {
  if (row.kind === 'offsite') {
    return {
      kind: 'offsite',
      externalUrl: safeExternalUrl(row.externalUrl),
    };
  }
  return {
    kind: 'onsite',
    appBlockId: row.appBlockId ?? null,
    hasPage: manifestHasPage(row.appBlock?.manifest),
    // Surfaced on the card so a client can link the onsite app without an N+1
    // detail fetch. Same derivation as the detail projection (shared helper).
    liveUrl: onsiteLiveUrl(row.slug),
  };
}

/**
 * The columns `cardOpenCount` reads. Widened from `HydratedListing` (which still satisfies
 * it structurally — a pure relaxation, no behaviour change) so the moderator review queue
 * can reuse the REAL projection instead of re-deriving it, the same reason
 * {@link DetailKindDataSource} is relaxed.
 *
 * ⚠️ `kind` IS OPTIONAL FOR THE CALLER'S CONVENIENCE AND THAT COSTS THE COMPILER'S HELP:
 * a select that omits the column no longer fails to typecheck, it silently reads as
 * not-on-site. The off-site mod queue therefore has to name `kind: true` deliberately, and
 * a test pins that it does.
 */
export type CardOpenCountSource = {
  kind?: string | null;
  metric?: { openCount: number } | null;
};

/**
 * The card's play count: a NUMBER for an on-site listing, `null` for an off-site one.
 *
 * 🔴 THE DISCRIMINATION IS THE WHOLE POINT, and `row.metric?.openCount ?? 0` alone —
 * the obvious implementation — is WRONG for every off-site card. `open_count` is
 * `Int NOT NULL DEFAULT 0`, so an off-site row carries a literal `0`; projecting it
 * would render "nobody has ever used this app" for an app whose CTA is a plain
 * `target="_blank"` anchor to a third party, where no on-platform request follows the
 * click and there is therefore nothing trustworthy to count. That number is ABSENT,
 * not zero, and `null` is how the DTO says so (the renderer omits the stat row).
 *
 * 🔴 AND DO NOT OVER-NULL. An on-site listing nobody has opened yet is a genuine `0`.
 * A missing metric row means "no plays recorded yet" ⇒ `0`, the same COALESCE-to-0
 * reading `installCount` uses — NOT `null`.
 *
 * 🔴 DISCRIMINATE ON `kind`, NEVER ON `appBlockId` NULLNESS. They are not the same
 * predicate: `schema.prisma` states at the `appBlockId` field that a natively-created
 * OFF-SITE listing also leaves it NULL, so an `appBlockId`-based test would be right
 * by accident on some rows and wrong on others.
 *
 * The positive `=== 'onsite'` test (rather than `!== 'offsite'`) is deliberate: it
 * fails CLOSED to `null` for any kind added later, because an omitted stat row is
 * honest about an unmeasured app while a `0` is a false claim about it. That property
 * is GUARDED, not merely stated — see the unknown-future-kind case in
 * `__tests__/app-listing.service.test.ts`; every other fixture there is onsite/offsite
 * and cannot tell this form apart from the fail-OPEN `=== 'offsite'` one.
 *
 * ✅ MERGE-ORDER CONSTRAINT — DISCHARGED. THIS PARAGRAPH IS RE-DERIVED, NOT EDITED
 * AROUND, SO READ IT RATHER THAN THE ONE IT REPLACES.
 *
 * It used to open "🔴 READ BEFORE SHIPPING THE RENDERER (Stage 4). NOTHING WRITES
 * `open_count` YET. `appListing.metrics.sql.ts` populates `install_count` only — its
 * own suite asserts `expect(upsert).not.toContain('open_count')`", and it required the
 * renderer either to wait for #4653 or to ship behind a flag, on the grounds that a
 * premature renderer would print "0 plays" on every on-site app INCLUDING heavily used
 * ones — by this field's own standard the worst outcome available, and on a public
 * surface.
 *
 * Every clause of that is now false, checked rather than assumed:
 *   · #4653 IS MERGED (`f9f81dcfb5`, "derive app_listing_metrics.open_count from
 *     App_Open events"), and #4652 before it (`6ff42aed42`) ships the App_Open events
 *     it derives from;
 *   · `appListing.metrics.sql.ts` names `open_count` in its INSERT and ON CONFLICT
 *     lists, and the suite assertion quoted above has INVERTED — the same file now
 *     asserts `toContain('COALESCE(oc."open_count", 0)')` and
 *     `toContain('"open_count" = EXCLUDED."open_count"')`;
 *   · the count is DERIVED from an all-time read on every rollup run rather than
 *     accumulated, so there is no backfill step gating correctness — a listing's
 *     number becomes right the first time the job covers it.
 *
 * The renderer (stage 4) therefore ships unflagged, and the flag this paragraph
 * declined to build is still not built and is no longer wanted.
 *
 * ⚠️ WHAT IS **NOT** CLAIMED HERE: that the rollup has already RUN over the whole
 * catalog in any given environment. That is an operational fact about a scheduled
 * job, not a property of this code — an on-site listing whose row the job has not yet
 * covered reads a truthful-by-the-DTO's-rule `0` until it does.
 */
export function cardOpenCount(row: CardOpenCountSource): number | null {
  if (row.kind !== 'onsite') return null;
  return row.metric?.openCount ?? 0;
}

/** What a `/apps/review` queue row shows about the app's store listing. */
export type ListingQueueFacts = {
  /** {@link cardOpenCount}'s answer — a number for an on-site listing, `null` otherwise. */
  playCount: number | null;
  iconUrl: string | null;
  coverUrl: string | null;
};

export type ListingQueueFactsSource = CardOpenCountSource & {
  icon?: { url: string | null } | null;
  cover?: { url: string | null } | null;
};

/** No listing to read — the two moderator queues project this for a row with none. */
export const NO_LISTING_QUEUE_FACTS: ListingQueueFacts = {
  playCount: null,
  iconUrl: null,
  coverUrl: null,
};

/**
 * One projection of a listing → the three facts both moderator review queues show.
 *
 * 🔴 IT GOES THROUGH `cardOpenCount` RATHER THAN READING `metric.openCount`, because the
 * obvious `metric?.openCount ?? null` is wrong in BOTH directions: it renders the literal
 * `0` an off-site listing's `NOT NULL DEFAULT 0` column carries, and it over-nulls an
 * on-site listing with no metric row yet, which is a genuine `0`. The store card and the
 * review row must not answer "how many plays" differently for one listing.
 *
 * 🔴 NO SCREENSHOT COVER FALLBACK. A moderator has to see that the listing has no cover —
 * the same reason the author's own `listMine` read passes `null` here.
 */
export function listingQueueFacts(listing: ListingQueueFactsSource): ListingQueueFacts {
  return {
    playCount: cardOpenCount(listing),
    iconUrl: iconUrl(listing.icon),
    coverUrl: coverUrl(listing.cover, null),
  };
}

/**
 * Project a hydrated listing row → the PUBLIC card DTO (allowlist).
 *
 * 🔴 `beta` is passed IN, and it is the SAME manual-apply trap `projectListingDetail`
 * documents at length — with a wider blast radius, because this projection backs the
 * public `/apps` GRID. Putting `isBeta: true` into `listingHydrateSelect` (the obvious
 * implementation, and the select this function's rows come from) makes every store read
 * that shares it throw P2022 from the moment this deploys until a human runs the SQL. The
 * caller resolves it through `readListingBetaManyForRender`, which degrades to an empty map on
 * ANY error, and the
 * row is not even consulted for it here. It defaults to {@link BETA_NOT_SET} so the many
 * existing fixtures and call sites that pass one argument keep working unchanged.
 */
export function projectListingCard(
  row: HydratedListing,
  beta: ListingBetaRead = BETA_NOT_SET
): ListingCard {
  const recommend = recommendRollup(row.metric);
  return {
    // Author-declared beta label — resolved by the caller through the manual-apply guard,
    // never selected on `row`. `false` covers BOTH "not in beta" and "the columns are not
    // there yet"; the card has no way to render the difference and no reason to.
    isBeta: beta.isBeta,
    id: row.id,
    slug: row.slug,
    kind: row.kind as ListingKind,
    name: row.name,
    tagline: row.tagline ?? null,
    category: row.category ?? null,
    contentRating: row.contentRating ?? null,
    iconUrl: iconUrl(row.icon),
    coverUrl: coverUrl(row.cover, firstScreenshotUrl(row)),
    creator: creatorChip(row.user),
    recommend,
    reviewCount: recommend.recommendedCount + recommend.notRecommendedCount,
    // Number for on-site, `null` for off-site — see `cardOpenCount`.
    openCount: cardOpenCount(row),
    kindData: cardKindData(row),
  };
}

/**
 * The listing columns `detailKindData` actually reads. Widened from
 * `HydratedListing` (which still satisfies it structurally — this is a pure
 * relaxation, no behaviour change) so a caller holding only the four off-site
 * columns can reuse the REAL projection instead of re-deriving it.
 *
 * 🔴 That reuse is the point: `app-listing-actionable.service` runs the go-live
 * actionability gate through this exact function, so the gate and the store can
 * never disagree about what a listing's detail renders. The on-site inputs are
 * optional because the on-site arm is the only consumer of them.
 */
export type DetailKindDataSource = {
  kind: string;
  slug: string;
  // `| undefined` so a Prisma *create input* (whose nullable columns are optional)
  // satisfies this as-is. Both consumers below (`safeExternalUrl` and the
  // `|| null` on `connectClientId`) treat `undefined` identically to `null`.
  externalUrl?: string | null;
  connectClientId?: string | null;
  appBlockId?: string | null;
  appBlock?: { manifest: Prisma.JsonValue } | null;
};

export function detailKindData(row: DetailKindDataSource): ListingDetailKindData {
  if (row.kind === 'offsite') {
    return {
      kind: 'offsite',
      externalUrl: safeExternalUrl(row.externalUrl),
      // The OAuth client_id is public (it's sent in the connect URL); the secret
      // is never selected here. Null when no OAuth app is connected.
      //
      // 🔴 `|| null`, NOT `?? null`, and that is deliberate: this used to read
      // `subKind === 'connect' ? row.connectClientId ?? null : null`, and the
      // removed sub-kind was `connectClientId ? 'connect' : 'external-link'` —
      // a TRUTHINESS test. So an EMPTY-STRING client id projected as `null`
      // before, and `?? null` would newly project it as `''`. `|| null` keeps
      // the wire value byte-identical for every input.
      connectClientId: row.connectClientId || null,
    };
  }
  return {
    kind: 'onsite',
    appBlockId: row.appBlockId ?? null,
    hasPage: manifestHasPage(row.appBlock?.manifest),
    // Already-public standalone origin (no token/scope) — same host the webhook
    // validates the bundle's iframe against. Shared derivation with the card
    // projection (onsiteLiveUrl) so list + detail can never drift.
    liveUrl: onsiteLiveUrl(row.slug),
  };
}

/** Ordered gallery — screenshots whose backing Image still exists. */
function galleryScreenshots(row: HydratedListing): ListingGalleryScreenshot[] {
  const out: ListingGalleryScreenshot[] = [];
  for (const s of row.screenshots) {
    // A row whose Image was deleted (imageId → null via onDelete: SetNull) must
    // NOT render as a blank tile. The select already filters imageId != null, but
    // guard defensively so a null-image row can never reach the wire.
    if (!s.image?.url) continue;
    out.push({ url: getEdgeUrl(s.image.url, { width: 1200 }), caption: s.caption ?? null });
  }
  return out;
}

/**
 * MOD-ONLY review preview: project a SHADOW / pending listing (by its own id — the
 * review row's `appListingId`) into the SAME `ListingCard` + `ListingDetail` store
 * shapes the public `getAppDetail` read serves, so the moderator sees the app's
 * REAL media (icon / cover / ordered screenshots) + scalars (name / tagline /
 * description / category / contentRating / creator) laid out as the store card +
 * detail — before approval.
 *
 * Reuses `listingHydrateSelect` + `projectListingCard` / `projectListingDetail`
 * verbatim (the SAME image→CDN-URL derivation as the approved-listing read), so the
 * preview can never drift from the live store projection and there is NO second
 * image-URL builder. UNLIKE the public read it is NOT status-filtered (a mod may
 * preview a draft / pending / shadow listing); the caller (`moderatorProcedure`) is
 * the authz gate. Read-only — no listing mutation. Returns `null` when the id has no
 * listing row (the client then falls back to a placeholder-art layout preview).
 */
export async function getListingPreviewForReview(args: {
  listingId: string;
}): Promise<{ card: ListingCard; detail: ListingDetail } | null> {
  const row = await dbRead.appListing.findUnique({
    where: { id: args.listingId },
    // `revisionOfId` on top of the shared select — the beta read below is keyed on the
    // PARENT for a shadow. Spread here rather than added to `listingHydrateSelect`, so the
    // public grid and detail reads are untouched (same pattern as `status` on the public
    // detail read). It is an ordinary long-standing column, not a manual-apply one.
    // `connectRequestedScopes` is spread in here rather than living in
    // `listingHydrateSelect`, so the public grid never depends on its manual-apply
    // migration — see the note at that select. Same reason `revisionOfId` is spread.
    select: { ...listingHydrateSelect, revisionOfId: true, connectRequestedScopes: true },
  });
  if (!row) return null;
  // Same manual-apply guard as the public read — a moderator previewing a shadow must
  // see the source link the apply will publish, and the preview must not 500 while the
  // migration is outstanding. `args.listingId` is the row this preview projects (a
  // shadow id here, deliberately), not its parent.
  //
  // 🔴 THE BETA READ IS KEYED ON THE **PARENT** FOR A SHADOW, and that is what lets beta
  // stay off the revision round trip entirely. Beta is never staged: every write targets the
  // live listing, so the PARENT row is the only place the current declaration exists. A
  // shadow's own beta columns are therefore not a source of truth — and the consequence of
  // reading them is worse than staleness, which is what an earlier version of this comment
  // said. NOTHING writes them: `beginListingRevision` clones no beta column and every write
  // path targets the parent, so a shadow's `is_beta` / `beta_message` hold the SCHEMA
  // DEFAULTS (`false` / `null`) for every shadow, always. Keying this read on the shadow id
  // would not show a moderator a stale value; it would remove the badge and the notice from
  // EVERY revision preview, which is precisely the framing the `preview` omission ledger in
  // `AppListingDetailBody` exists to guarantee.
  //
  // 🔴 THIS REPLACED A CLONE, AND REMOVING THAT CLONE IS THE POINT. `beginListingRevision`
  // used to copy the columns onto the shadow purely so this preview could render them. That
  // put an ordering constraint on `updateListing` — the parent's beta write had to land
  // before the shadow was minted or the clone captured the pre-edit value — and honouring it
  // hoisted a WRITE above the patch validation, so a patch that failed validation applied
  // its beta half anyway. Reading the parent here needs no clone, no ordering rule, and
  // cannot go stale.
  const betaSourceId = row.revisionOfId ?? args.listingId;
  const [sourceRepo, beta] = await Promise.all([
    readListingSourceRepoUrl(args.listingId, dbRead),
    readListingBetaForRender(betaSourceId, dbRead),
  ]);
  return {
    card: projectListingCard(row, beta),
    detail: projectListingDetail(row, [], sourceRepo.value, beta, row.connectRequestedScopes),
  };
}

/**
 * Project a hydrated listing row → the PUBLIC detail DTO (allowlist).
 *
 * `collaborators` is passed IN rather than selected on `row`, and that is deliberate
 * on two counts:
 *   1. INERTNESS. `app_collaborators` is a MANUAL-APPLY table. A nested Prisma select
 *      on it would make the whole public store-detail read fail with P2021 until a
 *      human applies the migration — turning an additive feature into an outage. The
 *      caller resolves them through `safeCollaboratorQuery`, which degrades to `[]`.
 *   2. PURITY. This projection stays synchronous and IO-free, so it remains directly
 *      unit-testable (which is how the public-projection allowlist is pinned).
 *
 * 🔴 The chips are built by the SAME `creatorChip` allowlist as `creator` — exactly
 * `{id, username, image}`, nothing else, ever.
 * `app-collaborator.public-projection.test.ts` asserts the projected key set is exactly
 * those three even when the input user row carries extra fields (email, bannedAt, …), so
 * a wider `select` upstream cannot leak through this seam.
 *
 * 🔴 `sourceRepoUrl` is passed IN for EXACTLY reason (1) above, and it is worth being
 * explicit that this is the same trap a second time, not a copied habit.
 * `app_listings.source_repo_url` is a MANUAL-APPLY COLUMN. Putting `sourceRepoUrl: true`
 * into `listingHydrateSelect` — the obvious implementation — makes every public store
 * read that shares that select (the `/apps` GRID as well as this detail page) throw
 * P2022 from the moment this deploys until a human runs the SQL. The caller resolves it
 * through `readListingSourceRepoUrl`, which degrades to null, and the row is not even
 * consulted for it here. It defaults to `null` so the several test fixtures and the
 * moderator preview path that call this with two arguments keep working unchanged.
 */
export function projectListingDetail(
  row: HydratedListing,
  collaborators: Array<{ id: number; username: string | null; image: string | null }> = [],
  sourceRepoUrl: string | null = null,
  beta: ListingBetaRead = BETA_NOT_SET,
  /**
   * The raw `AppListing.connectRequestedScopes` bitmask, PASSED IN for the same reason
   * `sourceRepoUrl` and `beta` are: its column is manual-apply and is deliberately not
   * named in `listingHydrateSelect`, which the public `/apps` GRID shares. Each DETAIL
   * caller spreads it into its own select and hands it here.
   *
   * Defaulting to `null` means a caller that forgets it discloses NOTHING rather than
   * throwing — the safe direction for a permissions surface, and the same default shape
   * as its two neighbours.
   */
  connectRequestedScopes: number | null = null
): ListingDetail {
  const recommend = recommendRollup(row.metric);
  return {
    // Author-declared beta label + note. Passed IN for the SAME manual-apply reason as
    // `sourceRepoUrl` above — the columns are never named in `listingHydrateSelect`.
    // 🔴 `beta.isBeta`, NOT `beta.betaMessage != null`: an author may declare beta WITHOUT
    // writing a note, and the badge must still show. Deriving the flag from the message
    // would make a note the price of the label.
    isBeta: beta.isBeta,
    // 🔴 Only carried when the flag is set. A stale note left behind by an author who
    // turned beta OFF must not reach a public DTO, and clearing it at the write site alone
    // would leave every row written before that rule existed able to leak one.
    betaMessage: beta.isBeta ? beta.betaMessage : null,
    collaborators: collaborators
      .map((u) => creatorChip(u))
      .filter((c): c is ListingCreatorChip => c !== null),
    id: row.id,
    serialId: row.serialId,
    slug: row.slug,
    kind: row.kind as ListingKind,
    name: row.name,
    tagline: row.tagline ?? null,
    description: row.description ?? null,
    category: row.category ?? null,
    contentRating: row.contentRating ?? null,
    iconUrl: iconUrl(row.icon),
    coverUrl: coverUrl(row.cover, firstScreenshotUrl(row)),
    creator: creatorChip(row.user),
    recommend,
    reviewCount: recommend.recommendedCount + recommend.notRecommendedCount,
    // ISO-8601, not a `Date` — this DTO also crosses the transformer-less public REST
    // boundary. See the field's docstring on `ListingDetail`.
    updatedAt: row.updatedAt.toISOString(),
    // `COALESCE(install_count, 0)` in projection form: a listing with no metric row
    // has had no installs, exactly as the ranking SQL reads it.
    installCount: row.metric?.installCount ?? 0,
    // Public source-repo link — resolved by the caller through the manual-apply guard,
    // never selected on `row`. See this function's docstring. Normalised at every write
    // (`validateRepositoryUrl`), so what reaches the wire is always
    // `https://<allowlisted-host>/<owner>/<repo>`.
    sourceRepoUrl: sourceRepoUrl ?? null,
    screenshots: galleryScreenshots(row),
    kindData: detailKindData(row),
    // Pre-launch permission disclosure. IDENTICAL projection to the one
    // `BlockRegistry.getAppDetail` already ships for the same purpose — the
    // approved scope ids, string-filtered, `[]` when the column is NULL.
    //
    // 🔴 `approvedScopes`, NOT the manifest's self-declared `scopes`, AND THE REASON
    // IS THAT THE TWO GENUINELY DIVERGE — do not "simplify" this to `manifest.scopes`.
    //
    // ⚠ An earlier version of this comment claimed they "can never disagree because
    // the approve paths write them in the same update". That is FALSE, and it deleted
    // the only reason this line reads the column it does.
    // `src/pages/api/v1/developer/block-manifests.ts` updates `manifest` + `version`
    // on an existing AppBlock WITHOUT touching `approvedScopes`, and sets
    // `status: 'pending'` — deliberately, so a publisher cannot swap `iframe.src` or
    // sandbox tokens post-approval without re-entering moderation. So a row can hold
    // a v2 manifest declaring `['models:read:self','ai:write:budgeted']` alongside a
    // v1 `approvedScopes` of `['models:read:self']`.
    //
    // Reading the manifest there would publish a scope NOBODY APPROVED on a public
    // store page — the app's own claim about itself, rendered as if granted.
    // `approvedScopes` is written only by the three approve paths
    // (`publish-request.service.ts`), which take `manifest.scopes` verbatim at approve
    // time; there is no per-scope narrowing mechanism, so the only skew is
    // approve→deploy, where this over-discloses. That is the safe direction.
    //
    // 🔴 GATED ON `kind`, NEVER ON `appBlockId` NULLNESS — they are not the same
    // predicate. `mapAppBlockToListing` mints `kind: 'offsite'` WITH a non-null
    // `appBlockId` whenever the source AppBlock carries an `externalUrl`, reachable
    // through the mod proc `blocks.backfillAppListings`; `schema.full.prisma` says in
    // as many words to discriminate on `kind`.
    //
    // 🔴 THE CONSOLIDATION VEHICLE ALREADY EXISTS — `CAPABILITIES_BY_KIND` /
    // `listingKindSupports` in `src/shared/constants/app-capabilities.constants.ts`.
    // If this gate is ever consolidated, ADD A CAPABILITY CELL there; do NOT build a
    // new helper.
    //
    // 🔴 DELIBERATELY NO COUNTS AND NO SITE LIST HERE — read
    // `KIND_CAPABILITY_LEDGER` in
    // `src/server/services/blocks/__tests__/app-access.call-site-ledger.test.ts`,
    // which is growth-and-shrink gated and therefore cannot go stale the way a
    // sentence can. THREE successive drafts of this comment quoted a number or a
    // site list and all three were WRONG: "the third consumer" (undercount), then
    // "five, open-coded by hand" (two already used the table), then "~14 absorbed"
    // (that figure belongs to `app-access.service.ts`'s separate OWNERSHIP-gate
    // consolidation, not to the capability table) alongside "two of five already
    // route through it" (it is four of five). Each wrong draft was written while
    // fixing the previous one. The form is the defect, not the arithmetic — so the
    // number now lives only where a test asserts it.
    //
    // Without the gate, such a row renders the off-site disclosure — "This app runs
    // entirely off-platform — no Civitai install, account access, or permissions" —
    // directly above "This app can… ai:write:budgeted". Two contradictory SECURITY
    // claims on a public store page. The population is 0 in production (measured
    // 2026-08-11: offsite 5 rows, 0 with a block), so this is PREVENTION, not a
    // live bug — and prevention is cheap here because it is one clause.
    scopes:
      row.kind === 'onsite' && Array.isArray(row.appBlock?.approvedScopes)
        ? row.appBlock.approvedScopes.filter((s): s is string => typeof s === 'string')
        : [],
    // The OFF-SITE analog of `scopes` above: the account permissions an
    // OAuth-connect listing will ASK the viewer to approve, decoded from the
    // `connectRequestedScopes` bitmask into TokenScope enum-keys.
    //
    // 🔴 GATED ON `kind` **AND ON THE CONNECT CLIENT'S PRESENCE**, and the second
    // half is not belt-and-braces — omitting it is a live public-page defect.
    //
    // `connectClient` is `onDelete: SetNull` (`schema.full.prisma:2899`) while
    // `connectRequestedScopes` is an independent `Int?` the cascade never touches, and
    // deleting an OAuth client is owner-callable with no check for referencing
    // listings. `app-transfer.constants.ts` already records the resulting state in
    // writing — "SetNull nulls the listing's connectClientId, STRANDING the
    // connectRequestedScopes … an owner-initiated route out of this refusal EXISTS
    // TODAY". The listing stays `approved` and keeps serving.
    //
    // Without this clause that stranded row publishes scopes while
    // `shouldShowOffsiteDisclosure` — which is `… && !kindData.connectClientId` — turns
    // TRUE, so one public page renders "no Civitai install, account access, or
    // permissions" directly above "Permissions this app may request (2) / Sensitive
    // permissions (2)". Two contradictory SECURITY claims, and the permissions half is
    // the FALSE one: with no client, nothing can be asked for. `app-listing.service.test.ts`
    // already refuses exactly this shape for `scopes`, in those words.
    //
    // ⚠ THIS IS NOT THE `appBlockId`-vs-`kind` RULE, AND AN EARLIER DRAFT CONFLATED
    // THEM. That rule says do not infer an on-site KIND from `appBlockId` nullness —
    // `mapAppBlockToListing` can mint `kind: 'offsite'` WITH a non-null `appBlockId`, so
    // `kind` is the kind discriminator and stays one here. `connectClientId` is not
    // being used as a kind discriminator: it answers a different question — is there a
    // client that could request anything at all — and `kind === 'offsite'` does not
    // imply there is one.
    //
    // 🔴 DECODED HERE, SERVER-SIDE, THROUGH THE SHARED TABLE. `tokenScopeMaskToList`
    // is the same expansion the hub's OAuth consent screen uses; its own module
    // says forking the bitmask/labels would be a latent security bug. Sending the
    // raw Int instead would push that decode onto every consumer of a PUBLIC REST
    // endpoint and couple them to bit positions.
    //
    // 🔴 NO STATUS CLAUSE, DELIBERATELY. `getListingDetail` already returns null
    // for `status !== 'approved'` before reaching this projection, so a draft's
    // intended scopes cannot ride the public read; adding the clause here would be
    // unreachable on that path. On the OTHER caller it would be actively wrong —
    // `getListingPreviewForReview` is deliberately not status-filtered so a
    // moderator can preview a draft, and a status gate here would blank the
    // enumeration they are reviewing. `appListingConnectScopes.test.ts` pins both
    // halves so this reliance cannot rot into a sentence nobody rechecks.
    // Truthiness on `connectClientId`, not `!= null` — `kindData` normalises `'' → null`
    // (`row.connectClientId || null` above), so an empty string must read as "no client"
    // on BOTH sides or the two surfaces disagree at exactly that value.
    connectScopes:
      row.kind === 'offsite' &&
      Boolean(row.connectClientId) &&
      typeof connectRequestedScopes === 'number'
        ? tokenScopeMaskToList(connectRequestedScopes).map((s) => s.key)
        : [],
  };
}

// ---------------------------------------------------------------------------
// SQL fragment builders (exported for the SQL drift-guard unit tests).
// ---------------------------------------------------------------------------

/**
 * The `top-rated` Bayesian recommend sort key, as a single zero-padded sortable
 * TEXT. Reused IDENTICALLY in SELECT (AS sort_key) + the keyset WHERE — if it
 * drifts, keyset pagination silently skips rows.
 *
 *   score = (C*m + up) / (C + up + down)
 *     C = prior (LISTING_BAYES_PRIOR), m = global recommend mean, up/down =
 *     thumbsUp/Down from the AppListingMetric rollup (0 when absent).
 *   0-review apps → score = m (mid-pack). Ties break on install_count then id.
 */
export function listingBayesianSortKey(globalMean: number): Prisma.Sql {
  const score = Prisma.sql`(
    (${LISTING_BAYES_PRIOR}::float * ${globalMean}::float + COALESCE(m.thumbs_up_count, 0))
    / (${LISTING_BAYES_PRIOR}::float + COALESCE(m.thumbs_up_count, 0) + COALESCE(m.thumbs_down_count, 0))
  )`;
  // NB: lpad length args cast to ::int — Prisma binds JS number constants as
  // bigint, and `lpad(text, bigint, unknown)` has no overload (signature is
  // `lpad(text, integer, text)`) → the query 500s at runtime otherwise. (Same
  // trap the AppBlock rating sort hit; see block-registry.service.)
  return Prisma.sql`(
    lpad(round(${score} * ${BAYES_SCORE_SCALE})::bigint::text, ${BAYES_SCORE_PAD}::int, '0')
    || lpad(COALESCE(m.install_count, 0)::text, ${INSTALL_PAD}::int, '0')
  )`;
}

/** The sort-key TEXT expression for a given sort (+ whether it sorts DESC). */
export function listingSortKeyExpr(
  sort: ListingSort,
  globalMean: number
): { expr: Prisma.Sql; descending: boolean } {
  switch (sort) {
    case 'top-rated':
      return { expr: listingBayesianSortKey(globalMean), descending: true };
    case 'popular':
      return {
        expr: Prisma.sql`lpad(COALESCE(m.install_count, 0)::text, ${INSTALL_PAD}::int, '0')`,
        descending: true,
      };
    case 'newest':
      return {
        expr: Prisma.sql`to_char(al.created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS')`,
        descending: true,
      };
    case 'name':
    default:
      // `name` is unbounded `text`; the RAW sort key is encoded into the base64 cursor, so a
      // long name could overflow the cursor bound (`LISTING_CURSOR_MAX`, sized for 64
      // four-byte characters) and halt pagination (BAD_REQUEST). Bound the key to 64 chars —
      // IDENTICAL in SELECT + the keyset WHERE (same `expr`), so paging stays exact; `al.id`
      // remains the total-order tiebreak, so a 64-char-truncation collision still paginates.
      return { expr: Prisma.sql`left(LOWER(al.name), 64)`, descending: false };
  }
}

/**
 * Maturity gate — hide mature (r/x) listings off a red-capable host. Mirrors the
 * AppBlock `matureHostSqlFilter`. Fail-closed: a null/unknown rating is treated
 * as SFW (kept); the direction is fail-closed for the MATURE rows we must hide.
 */
export function listingMatureFilter(redCapable: boolean): Prisma.Sql {
  if (redCapable) return Prisma.sql`TRUE`;
  return Prisma.sql`COALESCE(LOWER(al.content_rating), '') NOT IN ('r', 'x')`;
}

/** {@link listingMatureFilter} for the sub-listing alias `s`. */
export function subListingMatureFilter(redCapable: boolean): Prisma.Sql {
  if (redCapable) return Prisma.sql`TRUE`;
  return Prisma.sql`COALESCE(LOWER(s.content_rating), '') NOT IN ('r', 'x')`;
}

/**
 * Every condition that makes a LISTING eligible for the store grid, over the aliases `al`
 * (the listing) and `ab` (its backing block). The parent arm and the sub-listing arm of the
 * catalog statement both apply this to the parent row, so a child can never be visible while
 * its parent is not. Do not copy any of it into either arm.
 */
export function storeEligibilityWhere(args: {
  levelFilter: Prisma.Sql;
  kind: ListingKind | null;
  category: string | null;
  redCapable: boolean;
  scope: StoreVisibilityScope;
}): Prisma.Sql {
  return Prisma.sql`${args.levelFilter}
      -- A shadow revision is status='draft' and the level gate can admit a draft, so this is
      -- what keeps a shadow's un-reviewed content out of the store.
      AND al.revision_of_id IS NULL
      -- An onsite listing appears only once its block has deployed successfully at least once.
      AND (al.kind <> 'onsite' OR ab.current_version_deployed_at IS NOT NULL)
      AND (${args.kind}::text IS NULL OR al.kind = ${args.kind}::text)
      AND (${args.category}::text IS NULL OR al.category = ${args.category}::text)
      AND ${listingMatureFilter(args.redCapable)}
      AND ${listingPublicVisibilityFilter(args.scope)}`;
}

/**
 * The sort key for a sub-listing. The rating and popularity sorts reuse the PARENT's key, so
 * a child ties with its parent and the `tb` column orders the parent first.
 */
export function subListingSortKeyExpr(sort: ListingSort, globalMean: number): Prisma.Sql {
  switch (sort) {
    case 'top-rated':
    case 'popular':
      return listingSortKeyExpr(sort, globalMean).expr;
    case 'newest':
      return Prisma.sql`to_char(COALESCE(s.approved_at, s.created_at) AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS')`;
    case 'name':
    default:
      return Prisma.sql`left(LOWER(s.title), 64)`;
  }
}

/**
 * The STORE-SCOPE kind predicate — the load-bearing security boundary for the
 * public external App-store GA. Mirrors `listingMatureFilter`'s pure-`Prisma.Sql`
 * shape (uses the `al` alias, safe to AND into the keyset WHERE):
 *   - `full`            → `TRUE` (no kind restriction — byte-identical to today).
 *   - `public-external` → `al.kind = 'offsite'` — the offsite subset ONLY, whether
 *     or not the listing links an OAuth client. Onsite App Blocks are excluded.
 *     🔴 The kind gate is `kind='offsite'`, NOT `connect_client_id IS NULL` — an
 *     offsite listing is public whether or not it links an OAuth connect client.
 *     (This used to say "for BOTH sub-kinds (`connect` AND `external-link`)";
 *     that display taxonomy is gone — offsite is one kind — but the gate itself
 *     is unchanged, because it never keyed on the sub-kind in the first place.)
 *   - `none`            → `FALSE` — fail-closed. (The router short-circuits `none`
 *     before reaching SQL, so this is defense-in-depth, never the live path.)
 *
 * Exported so the drift-guard unit test can assert the exact SQL each scope emits.
 */
export function listingPublicVisibilityFilter(scope: StoreVisibilityScope): Prisma.Sql {
  if (scope === 'full') return Prisma.sql`TRUE`;
  if (scope === 'public-external') return Prisma.sql`al.kind = 'offsite'`;
  return Prisma.sql`FALSE`;
}

/**
 * The per-listing LEVEL gate — the status predicate this read has always had, WIDENED by
 * the viewer's audience floor.
 *
 * It replaces the bare `al.status = 'approved'` rather than being ANDed beside it, because
 * the whole point is that the level decides. Three properties, each load-bearing:
 *
 * 🔴 AN UNSET LEVEL (NULL) FALLS BACK TO THE PRE-FEATURE PREDICATE. The first disjunct IS
 * the old `al.status = 'approved'`, scoped to rows nobody has set a level on. That is what
 * makes this inert on every existing row and on every row a future approval mints — eight
 * scattered writes set `status='approved'` across four services with no chokepoint, and
 * none of them has to learn about this column.
 *
 * 🔴 A LEVEL THAT IS SET IS AUTHORITATIVE, INCLUDING ON AN `approved` LISTING. The second
 * disjunct admits only rows whose level the viewer's floor sees, so an owner can RESTRICT a
 * live listing as well as widen a draft. A stored value this build does not recognise is in
 * NO floor's level list, so it is excluded — fail closed.
 *
 * 🔴 THE WHOLE THING IS BOUNDED BY A STATUS ALLOWLIST, NOT BY THE LEVEL ALONE. `removed`
 * and `rejected` are negative moderation outcomes, and a level that reached them would be a
 * partial un-takedown of the owner's own app — so they are excluded here as well as at the
 * mutation, because a row can carry a level set BEFORE it was taken down.
 *
 * ⚠️ IT ALWAYS NAMES `al.visibility`, AND THE MANUAL-APPLY CASE IS HANDLED AT THE CALLER.
 * This is raw SQL inside a cached statement, so a missing column is a PARSE error no
 * per-column guard can swallow — `listAvailableListings` catches it and re-runs the
 * pre-feature predicate. An earlier revision pre-flight PROBED for the column here, which
 * cost a round trip on every grid read INCLUDING cache hits; neither in-tree sibling does
 * that, and both degrade via a catch instead.
 *
 * Exported so the drift-guard unit test can assert the exact SQL each floor emits.
 */
export function listingLevelVisibilityFilter(floor: ListingAudienceFloor): Prisma.Sql {
  // 🔴 PER-STATUS LEVEL LISTS, BECAUSE THE REVIEW CEILING IS PER STATUS. One shared
  // `al.visibility IN (...)` across every eligible status was a moderator-review bypass: it
  // admitted a `draft` carrying `visibility='public'` to the anonymous store, with a name,
  // URL and content rating no moderator had seen. See `maxVisibilityForStatus`.
  //
  // An unreviewed status against a non-moderator cohort admits NOTHING, so its list is
  // EMPTY — and an empty `IN ()` is a syntax error, hence the explicit FALSE.
  const approvedLevels = visibilitiesVisibleToForStatus(floor, 'approved');
  const unreviewed = VISIBILITY_ELIGIBLE_LISTING_STATUSES.filter((st) => st !== 'approved');
  const unreviewedLevels = visibilitiesVisibleToForStatus(floor, 'draft');
  // 🔴 AN ARM THE CEILING ADMITS NOTHING THROUGH IS OMITTED, NOT EMITTED AS `FALSE`. Two
  // reasons, and the second is why it matters beyond tidiness: an empty `IN ()` is a syntax
  // error, and a bare `FALSE` in this statement trips a sibling drift-guard
  // (`app-listing.public-scope.test.ts`) that scans the emitted SQL for exactly that word to
  // prove the KIND gate has not failed closed. Leaving one here would have made an unrelated
  // guard red for a reason that has nothing to do with what it protects.
  const arms: Prisma.Sql[] = [];
  if (approvedLevels.length) {
    arms.push(
      Prisma.sql`(al.status = 'approved' AND al.visibility IN (${Prisma.join(approvedLevels)}))`
    );
  }
  if (unreviewedLevels.length) {
    arms.push(
      Prisma.sql`(al.status IN (${Prisma.join(unreviewed)}) AND al.visibility IN (${Prisma.join(
        unreviewedLevels
      )}))`
    );
  }
  // No arm at all ⇒ a set level admits this cohort nowhere, so only the unset-and-approved
  // baseline remains.
  if (!arms.length) return Prisma.sql`(al.visibility IS NULL AND al.status = 'approved')`;
  return Prisma.sql`(
        (al.visibility IS NULL AND al.status = 'approved')
        OR (al.visibility IS NOT NULL AND (${Prisma.join(arms, ' OR ')}))
      )`;
}

// ---------------------------------------------------------------------------
// Global recommend mean (the Bayesian prior mean `m`, 1h-cached scalar).
// ---------------------------------------------------------------------------

/**
 * The store-wide mean recommend rate `m` across listings that have reviews
 * (up/(up+down) from the metric rollup), cached 1h. Falls back to the neutral
 * 0.5 when the store has no reviews yet (dark/empty) so a 0-review world still
 * produces a sane, stable `top-rated` sort.
 */
export async function getGlobalRecommendMean(): Promise<number> {
  const cacheable = queryCache(dbRead, 'getGlobalListingRecommendMean', 'v1');
  const rows = await cacheable<{ mean: number | null }[]>(
    Prisma.sql`
      SELECT AVG(m.thumbs_up_count::float / (m.thumbs_up_count + m.thumbs_down_count)) AS mean
      FROM app_listing_metrics m
      JOIN app_listings al ON al.id = m.app_listing_id
      WHERE al.status = 'approved'
        AND (m.thumbs_up_count + m.thumbs_down_count) > 0
    `,
    { ttl: CacheTTL.hour, tag: [APP_LISTING_RECOMMEND_MEAN_TAG] }
  );
  return rows[0]?.mean ?? DEFAULT_RECOMMEND_MEAN;
}

// ---------------------------------------------------------------------------
// The unified store CATALOG cache (`listAvailableListings`) + its ONE buster.
// ---------------------------------------------------------------------------

/**
 * Build the read-through cache for the `/apps` store's keyset id page, for ONE
 * viewer class.
 *
 * 🔴 THE TWO SECURITY-BOUNDARY AXES ARE LITERAL KEY SEGMENTS, NOT HASH INPUT.
 *
 * `queryCache` builds its redis key as `[key, version, hashifyObject(query)]
 * .join(':')` (`~/server/utils/cache-helpers`). `hashifyObject` → `hashify`
 * (`~/utils/string-helpers`) is a **32-bit** rolling hash
 * (`hash = (hash << 5) - hash + chr; hash |= 0`). It is neither injective nor
 * one-way, and it is LINEAR — collisions against a chosen target are constructed
 * algebraically, not brute-forced. An earlier revision of this code passed a
 * single constant `key` and relied on "every axis is interpolated into the
 * statement, so every axis is in the key". That reasoning silently assumes the
 * hash is injective, and it is not.
 *
 * It matters because an ATTACKER SUPPLIES HASHED BYTES. `decodeListingCursor`
 * slices `cursorSortKey` and `cursorId` out of a lenient base64url decode as
 * arbitrary free strings (only `cursorMean` is range-validated), the router
 * validates `cursor` only as a bounded string (`LISTING_CURSOR_MAX`), and both land in this
 * statement as bound params. That is enough tuning room to steer the 32-bit hash
 * onto any target value.
 *
 * So the two axes that are SECURITY BOUNDARIES are lifted out of the hashed
 * payload and into the `key` string itself:
 *
 *   · `scope` — `listingPublicVisibilityFilter`. `full` is the whole approved
 *     catalog; `public-external` is offsite-only. That is the public/onsite
 *     boundary (civitai#3983). A cross-scope collision would serve on-site apps
 *     into the anonymous `GET /api/v1/apps` response, and the reverse direction
 *     is cache poisoning.
 *   · `redCapable` — `listingMatureFilter`. A cross-capability collision serves
 *     `r`/`x` listings onto a SFW host.
 *
 * With both in the literal prefix, a hash collision can only ever mix two pages
 * WITHIN one viewer class — the class boundary is no longer hash-dependent.
 * `__tests__/app-listing.catalog-cache.test.ts` pins that the boundary lives in
 * the un-hashed segments.
 *
 * 🔴 WHAT IS LEFT UN-CONTAINED, STATED AS A RESIDUAL RATHER THAN A REASSURANCE. The
 * remaining axes (`kind`, `category`, `sort`, `cursor`, `limit`) stay in the hash, and
 * a constructed collision across them is CROSS-USER CACHE POISONING of the shared
 * `/apps` grid — not, as an earlier version of this comment said, "the attacker's own
 * page served back to themselves". The entry is shared by every viewer in the class,
 * and `full` is the class for ordinary logged-in users. The attacker's crafted-cursor
 * request MISSES, so it is the request that WRITES the colliding key; every later
 * reader deriving that key HITS it. So one request can pin the store's first page to
 * an arbitrary filtered — or empty — result for up to `CacheTTL.sm` (180s) for everyone
 * in that class.
 *
 * What it is NOT is a disclosure boundary: every row in a poisoned page came from a
 * statement carrying the SAME `scope` and `redCapable` predicates, so no listing
 * appears that the viewer was not already entitled to see. That is the whole reason
 * those two axes, and only those two, were lifted out of the hash.
 *
 * This residual is ACCEPTED, deliberately, and the cost of accepting it is the 180s
 * grid defect above. The alternative to accepting it is putting the remaining axes in
 * the literal key too, and the blocker is `cursor`: it is a free-form string of up to
 * `LISTING_CURSOR_MAX` characters, so lifting it out of the hash makes the redis keyspace
 * AND the `cache_name` metric label request-controlled and unbounded — exactly the
 * property the note at the bottom of this comment relies on. (`kind`, `category` and
 * `sort` are closed enums and `limit` is 1..50, so those four could be lifted; they would
 * multiply the label cardinality by their product, and they do not help while `cursor`
 * stays hashed, because `cursor` is the tuning room the collision is built out of.) Widening
 * `hashify` is the other alternative and it is global — see below.
 *
 * If that trade stops holding, the fix is to key on a per-axis allowlist plus a
 * cursor DIGEST computed with a real hash, not to widen `hashify`.
 *
 * 🔴 DO NOT "FIX" THIS BY WIDENING `hashify` — it is used across the codebase for
 * cache keys, DOM ids and de-dup, so changing its output is a global blast radius.
 * The containment belongs here, at the one call site that has a security boundary.
 *
 * Why `queryCache` + a bust tag, and not the alternatives:
 *
 * · **NOT `fetchThroughCache`** — it takes no `tag` option, so `bustCacheTag`
 *   cannot drive it and a moderator's approve/delist would not be visible until
 *   the TTL expired.
 *
 * · **NOT `clearCacheByPattern`** — banned for bust-on-mutation; see that
 *   function's own header. A prior use ran a cluster SCAN over a ~60M-key shard,
 *   producing redis timeouts and 504 waves, and was reverted.
 *
 * · **NOT a generation counter** — a counter folded into the key leaves the old
 *   entries in redis to expire on their own, so a bust multiplies the keyspace
 *   instead of reclaiming it. The tag set holds the exact keys to delete.
 *
 * ⚠️ `key` is also the `cache_name` label on the hit/miss counters. Its cardinality
 * is bounded at 36 (3 scopes × 3 audience floors × 2 capabilities × 2 sub-listing states) —
 * every component is a closed enum, never a request-controlled string.
 *
 * The sub-listing segment is literal for the same reason: it changes which ROWS the statement
 * returns, so a flag-on page must never be served to a flag-off viewer.
 *
 * 🔴 THE AUDIENCE FLOOR IS A LITERAL KEY SEGMENT FOR THE SAME REASON `scope` IS, and it
 * had to be: it changes which ROWS the cached statement returns. Folding it into
 * `hashifyObject` would put a security-boundary axis behind a 32-bit non-injective hash,
 * and leaving it out entirely would serve one cohort's id page to another — a moderator's
 * page, including `draft` listings, to a general viewer. It is a closed 3-value enum, so
 * it triples a keyspace that was bounded at 6 rather than opening it.
 */
function catalogPageCache(
  scope: StoreVisibilityScope,
  floor: ListingAudienceFloor,
  redCapable: boolean,
  withSubListings: boolean
) {
  return queryCache(
    dbRead,
    `listAvailableAppListings:${scope}:${floor}:${redCapable ? 'red' : 'sfw'}:${
      withSubListings ? 'sl' : 'nosl'
    }`,
    'v1'
  );
}

let subListingTableMissingLogged = false;

/** Logged once per process: the manual-apply sub-listing tables are absent. */
function noteSubListingTableMissing(err: unknown): void {
  if (subListingTableMissingLogged) return;
  subListingTableMissingLogged = true;
  logToAxiom({
    name: 'app-sub-listing-table-missing',
    type: 'warning',
    message: err instanceof Error ? err.message : String(err),
  }).catch(() => null);
}

/**
 * Bust the `/apps` store catalog cache. THE one buster — nothing else deletes the tag.
 *
 * 🔴 THE RULE IS "BUST WHEN A CACHED AXIS OR CATALOG MEMBERSHIP MOVES", NOT "every
 * listing-state mutation busts". Several call sites used to invoke the latter as a
 * "uniform rule"; it is not uniform, and stating it that way made a reader's model of
 * the cache wrong in the expensive direction — it implies that a writer WITHOUT a bust
 * is a bug, when a whole enumerated list of them are deliberate and correct. The cached
 * statement reads
 * `al.status`, `al.kind`, `al.revision_of_id`, `al.category`, `al.content_rating`,
 * `al.app_block_id` + `ab.current_version_deployed_at` (the deploy gate and its join
 * key) and the `sort_key` inputs (`al.name`, `al.created_at`, the metric rollup) — and
 * nothing else. Every other column on the card is hydrated live below the cache and can
 * never be served stale. ⚠️ The metric rollup is on `app_listing_metrics`, not on this
 * table, and its two writers deliberately do NOT bust; `APP_LISTING_CATALOG_TAG`'s
 * header in `app-listing-cache.constants.ts` states that exception in full.
 *
 * Some busts ARE kept on paths that are inert today, as cheap defence-in-depth against
 * a future edit promoting the row into the catalog: `updateListing`'s `removed` and
 * `draft`/`pending` branches, its material-shadow branch, `submitListingRevision`,
 * `rejectExternalRequest` and `claimListing`. Each says so at its own call site. They
 * are a judgement, not the rule.
 *
 * ⚠️ THAT LIST IS PROSE AND NOTHING ASSERTS ON IT. The ledger pins WHICH functions bust
 * and which are `EXEMPT`; it does not pin which of the busts are inert, because that is
 * a claim about the SQL a branch can write rather than about a call site. Re-derive it
 * from the call-site comments rather than trusting the enumeration here.
 *
 * The asserted form of the rule — every `AppListing` writer either busts or is on an
 * `EXEMPT` list with a reason — is
 * `~/server/services/blocks/__tests__/app-listing.catalog-bust-ledger.test.ts`. That
 * file, not this paragraph, is what a new mutation has to satisfy.
 *
 * Fire-and-forget by the caller's convention (mirrors `bustRecommendMeanCache` in
 * `app-listing-review.service`): a cache-bus outage must never fail the mutation
 * that already committed. The worst case of a swallowed failure is a stale store
 * grid for at most `CacheTTL.sm`; the worst case of a thrown one is a moderator
 * action that reports failure after having succeeded.
 */
export async function bustAppListingCatalogCache(): Promise<void> {
  await bustCacheTag([APP_LISTING_CATALOG_TAG]);
}

// ---------------------------------------------------------------------------
// Read procs (over BOTH kinds, approved-only, public allowlist).
// ---------------------------------------------------------------------------

type ListAvailableListingsOpts = {
  redCapable?: boolean;
  scope?: StoreVisibilityScope;
  /**
   * The viewer's audience floor. 🔴 DEFAULTS TO `public`, THE LEAST-PRIVILEGED VALUE —
   * the floor is the NARROWEST level that admits the viewer, so the widest level is the
   * weakest grant. An omitted floor therefore admits only what an anonymous viewer could
   * already see, which is the same fail-closed posture `narrowStoreScope` applies to
   * `scope` and for the same reason: a default is an authorization decision.
   */
  floor?: ListingAudienceFloor;
  /**
   * Mix approved sub-listings into the page (the `app-store-sub-listings` flag). Off by
   * default, and the public REST catalog never sets it, so its output is unchanged.
   */
  includeSubListings?: boolean;
  /** The viewer's browsing level, for the per-render check of sub-listing images. */
  viewerBrowsingLevel?: number | null;
};

/**
 * List approved listings of BOTH kinds for the unified store. Keyset-paginated
 * over a computed `sort_key`; the row-value tuple `(sort_key, id)` is a total
 * keyset so a paged scan stays stable even across tied sort values.
 *
 * Two-step: a raw keyset query resolves the ORDERED, filtered page of ids
 * (joining the metric rollup for the sort), then a live hydration fetches the public
 * projection fields and we re-apply the raw order.
 *
 * With `includeSubListings`, the keyset runs over the UNION of listings and their approved
 * sub-listings, ordered `(sort_key, tb, id)` where `tb` is 0 for a listing and 1 for a child,
 * so a parent sorts before its children on an equal key.
 */
export async function listAvailableListings(
  input: ListAppListingsInput,
  opts?: ListAvailableListingsOpts & { includeSubListings?: false }
): Promise<{ items: ListingCard[]; nextCursor?: string }>;
export async function listAvailableListings(
  input: ListAppListingsInput,
  opts: ListAvailableListingsOpts
): Promise<{ items: StoreGridItem[]; nextCursor?: string }>;
export async function listAvailableListings(
  input: ListAppListingsInput,
  opts: ListAvailableListingsOpts = {}
): Promise<{ items: StoreGridItem[]; nextCursor?: string }> {
  const { kind, category, sort, cursor, limit } = input;
  const redCapable = opts.redCapable ?? false;
  const floor: ListingAudienceFloor = opts.floor ?? 'public';
  // 🔴 FAIL CLOSED on an absent / unrecognized scope (civitai#3983). This used to be
  // `opts.scope ?? 'full'`, on the reasoning that every caller passes an explicit
  // scope. Every caller does — and production still reached here with `undefined`,
  // so the `??` fired and this function served the WHOLE approved catalog (on-site
  // apps included) to anonymous callers of the public REST endpoint. A default is an
  // authorization decision; the only safe one here is `none` → `FALSE` predicate →
  // an empty page. `narrowStoreScope` is the single shared rule; see
  // `~/shared/utils/store-visibility-scope`.
  const scope = narrowStoreScope(opts.scope);
  const includeSubListings = opts.includeSubListings === true;

  const { cursorSortKey, cursorId, cursorMean } = decodeListingCursor(cursor);

  // Only `top-rated` needs the global mean. PIN it into the cursor across a
  // paging session (page 1 reads the 1h cache + encodes it; pages 2..N reuse
  // the pinned value, NOT a fresh read) so the sort key can't shift mid-scan.
  // ⚠️ THERE IS NO PRE-FLIGHT PROBE HERE. The degradation for the manual-apply
  // `visibility` column is the `isMissingColumnError` catch on the cached read below and
  // nothing else; deleting that catch takes the public grid down while the migration is
  // outstanding.
  const globalMean = sort === 'top-rated' ? cursorMean ?? (await getGlobalRecommendMean()) : 0;

  const { expr: sortKeyExpr, descending } = listingSortKeyExpr(sort, globalMean);
  const dir = descending ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  const keysetCmp = descending ? Prisma.sql`<` : Prisma.sql`>`;
  const eligibility = (levelFilter: Prisma.Sql) =>
    storeEligibilityWhere({
      levelFilter,
      kind: kind === 'all' ? null : kind,
      category: category ?? null,
      redCapable,
      scope,
    });

  // 1 = the cursor sits on a child row: children sort after their parent on the same key.
  const cursorTb = isAppSubListingId(cursorId) ? 1 : 0;
  // On the parents-only statement a child cursor means every parent on that sort key was
  // already served (parents sort before their children), so it resumes strictly after the
  // key. Comparing the parent id against an `asl_` id instead would serve such a parent
  // twice, e.g. when the flag turns off or the tables are missing between two pages.
  const parentKeyset =
    cursorTb === 1
      ? Prisma.sql`${sortKeyExpr} ${keysetCmp} ${cursorSortKey}::text`
      : Prisma.sql`(${sortKeyExpr}, al.id) ${keysetCmp} (${cursorSortKey}::text, ${cursorId}::text)`;

  // 🔴 CACHED. Only the keyset ID PAGE is cached — the hydration below stays a live
  // read, exactly as `getPostsInfinite` (`~/server/services/post.service`) does it, so
  // a card's mutable projection fields are never served from two different ages.
  //
  // The cache is built PER VIEWER CLASS: `scope`, `floor`, `redCapable` and the sub-listing
  // state are literal segments of the redis key, deliberately outside the 32-bit
  // `hashifyObject` of the statement. See {@link catalogPageCache}.
  //
  // TTL = `CacheTTL.sm` (180s). Rows enter and leave only through moderator or owner
  // actions, and every one of those paths calls `bustAppListingCatalogCache()`.
  //
  // 🔴 WHAT THE TTL IS AND IS NOT. It is a bound on staleness for the paths that have
  // no mutation to hang a bust on. It is NOT a redis-outage backstop: `queryCache` has no
  // fail-open, so a redis outage is a 500 on `/apps` and on `GET /api/v1/apps`.
  const parentsOnlyPage = (levelFilter: Prisma.Sql) =>
    catalogPageCache(
      scope,
      floor,
      redCapable,
      false
    )<{ id: string; sort_key: string }[]>(
      Prisma.sql`
    SELECT al.id, ${sortKeyExpr} AS sort_key
    FROM app_listings al
    LEFT JOIN app_listing_metrics m ON m.app_listing_id = al.id
    LEFT JOIN app_blocks ab ON ab.id = al.app_block_id
    WHERE ${eligibility(levelFilter)}
      AND (
        ${cursorSortKey}::text IS NULL
        OR ${parentKeyset}
      )
    ORDER BY sort_key ${dir}, al.id ${dir}
    LIMIT ${limit + 1}
  `,
      { ttl: CacheTTL.sm, tag: [APP_LISTING_CATALOG_TAG] }
    );

  // The keyset over (sort_key, tb, id), for one arm whose tb is fixed. Applied inside each arm
  // with its own ORDER BY / LIMIT so neither arm sorts more than a page.
  const armKeyset = (keyExpr: Prisma.Sql, idCol: Prisma.Sql, tb: number) => Prisma.sql`(
        ${cursorSortKey}::text IS NULL
        OR ${keyExpr} ${keysetCmp} ${cursorSortKey}::text
        OR (${keyExpr} = ${cursorSortKey}::text AND (
          ${tb}::int > ${cursorTb}::int
          OR (${tb}::int = ${cursorTb}::int AND ${idCol} ${keysetCmp} ${cursorId}::text)
        ))
      )`;
  const childKeyExpr = subListingSortKeyExpr(sort, globalMean);
  const withSubListingsPage = (levelFilter: Prisma.Sql) =>
    catalogPageCache(
      scope,
      floor,
      redCapable,
      true
    )<{ id: string; sort_key: string }[]>(
      Prisma.sql`
    SELECT u.id, u.sort_key FROM (
      (SELECT al.id, ${sortKeyExpr} AS sort_key, 0 AS tb
      FROM app_listings al
      LEFT JOIN app_listing_metrics m ON m.app_listing_id = al.id
      LEFT JOIN app_blocks ab ON ab.id = al.app_block_id
      WHERE ${eligibility(levelFilter)}
        AND ${armKeyset(sortKeyExpr, Prisma.sql`al.id`, 0)}
      ORDER BY sort_key ${dir}, al.id ${dir}
      LIMIT ${limit + 1})
      UNION ALL
      (SELECT s.id, ${childKeyExpr} AS sort_key, 1 AS tb
      FROM app_sub_listings s
      JOIN app_listings al ON al.id = s.parent_listing_id
      JOIN app_sub_listing_parents sp ON sp.parent_listing_id = s.parent_listing_id
      -- A banned or deleted author's items leave the store with them.
      JOIN "User" au ON au.id = s.author_user_id AND au."bannedAt" IS NULL AND au."deletedAt" IS NULL
      LEFT JOIN app_listing_metrics m ON m.app_listing_id = al.id
      LEFT JOIN app_blocks ab ON ab.id = al.app_block_id
      WHERE ${eligibility(levelFilter)}
        AND sp.enabled
        AND s.status = 'approved'
        -- An on-site child opens under the parent's run route, which serves only an approved
        -- block (a suspended or re-submitted block would make every child link a 404). An
        -- off-site child opens the parent's link template instead.
        AND CASE WHEN al.kind = 'offsite'
              THEN ${PARENT_LINK_TEMPLATE_SQL} IS NOT NULL
              ELSE ab.status = 'approved' END
        AND ${subListingMatureFilter(redCapable)}
        AND ${armKeyset(childKeyExpr, Prisma.sql`s.id`, 1)}
      ORDER BY sort_key ${dir}, s.id ${dir}
      LIMIT ${limit + 1})
    ) u
    ORDER BY u.sort_key ${dir}, u.tb ASC, u.id ${dir}
    LIMIT ${limit + 1}
  `,
      { ttl: CacheTTL.sm, tag: [APP_LISTING_CATALOG_TAG] }
    );

  // 🔴 THE VISIBILITY CATCH IS NARROW AND THE FALLBACK IS THE PRE-FEATURE PREDICATE. Not
  // `private`, which would empty the public grid on an unapplied migration, and not `public`,
  // which would admit drafts. Everything that is not a missing column PROPAGATES, because
  // degrading on those turns a real outage into a quietly short store page.
  const pageWithVisibilityFallback = (withSubListings: boolean) => {
    const page = withSubListings ? withSubListingsPage : parentsOnlyPage;
    return page(listingLevelVisibilityFilter(floor)).catch((err: unknown) => {
      if (!isMissingColumnError(err)) throw err;
      noteDegradedVisibilityRead(err);
      return page(Prisma.sql`al.status = 'approved'`);
    });
  };

  // The sub-listing tables are manual-apply too: while they are absent the store serves
  // parents only rather than failing.
  const idRows = await pageWithVisibilityFallback(includeSubListings).catch(
    async (err: unknown) => {
      if (!includeSubListings) throw err;
      const { isMissingTableError } = await import('~/server/services/blocks/app-access.service');
      if (!isMissingTableError(err)) throw err;
      noteSubListingTableMissing(err);
      return pageWithVisibilityFallback(false);
    }
  );

  const trimmed = idRows.slice(0, limit);
  const last = trimmed[trimmed.length - 1];
  const pinnedMean = sort === 'top-rated' ? globalMean : undefined;
  const nextCursor =
    idRows.length > limit && last
      ? encodeListingCursor(last.sort_key, last.id, pinnedMean)
      : undefined;

  if (trimmed.length === 0) return { items: [], nextCursor: undefined };

  const pageIds = trimmed.map((r: { id: string; sort_key: string }) => r.id);
  const listingIds = pageIds.filter((id) => !isAppSubListingId(id));
  const subListingIds = pageIds.filter((id) => isAppSubListingId(id));
  // 🔴 IN PARALLEL, not serially: all three reads are keyed on ids already in hand. The beta
  // read is render-tolerant (a failure renders every card as not-beta).
  const [hydrated, betaById, subListingById] = await Promise.all([
    listingIds.length
      ? dbRead.appListing.findMany({
          where: { id: { in: listingIds } },
          select: listingHydrateSelect,
        })
      : Promise.resolve([] as HydratedListing[]),
    listingIds.length
      ? readListingBetaManyForRender(listingIds, dbRead)
      : Promise.resolve(new Map<string, ListingBetaRead>()),
    hydrateSubListingCards(dbRead, subListingIds, {
      browsingLevel: opts.viewerBrowsingLevel,
      redCapable,
    }),
  ]);
  const byId = new Map(hydrated.map((r: HydratedListing): [string, HydratedListing] => [r.id, r]));
  const items: StoreGridItem[] = [];
  for (const id of pageIds) {
    const child = subListingById.get(id);
    if (child) {
      items.push(child);
      continue;
    }
    const row = byId.get(id);
    // 🔴 `?? BETA_NOT_SET`, not `?? BETA_UNAVAILABLE`: a row present in `hydrated` but
    // absent from the beta map means the columns WERE readable and that listing simply had
    // no row when the second query ran.
    if (row) items.push(projectListingCard(row, betaById.get(row.id) ?? BETA_NOT_SET));
  }

  return { items, nextCursor };
}

/**
 * Per-listing public detail, by EXACTLY ONE of slug or id. Approved-only: a
 * missing OR non-approved (draft/pending/rejected) listing returns null — the
 * router maps that to NOT_FOUND so an unapproved listing can't be enumerated.
 * Off a red-capable host a mature (r/x) listing also returns null (→ NOT_FOUND).
 */
export async function getListingDetail(
  input: GetAppListingDetailInput,
  opts: {
    redCapable?: boolean;
    scope?: StoreVisibilityScope;
    /** The viewer's audience floor. Defaults to `public` — see `listAvailableListings`
     *  for why the widest level is the least-privileged default. */
    floor?: ListingAudienceFloor;
  } = {}
): Promise<ListingDetail | null> {
  const redCapable = opts.redCapable ?? false;
  const floor: ListingAudienceFloor = opts.floor ?? 'public';
  // 🔴 FAIL CLOSED on an absent / unrecognized scope — see listAvailableListings
  // (civitai#3983). Previously `opts.scope ?? 'full'`, which let an absent scope
  // reach a listing's full detail through the public REST endpoint.
  const scope = narrowStoreScope(opts.scope);
  // STORE-SCOPE `none` (default-closed): a caller with no store visibility gets
  // nothing — symmetric with the list path's `listingPublicVisibilityFilter('none')`
  // → FALSE. The v1 endpoints short-circuit `none` before calling this, but honor
  // the gate here too so a future non-endpoint caller passing `none` can't reach a
  // listing's detail.
  if (scope === 'none') return null;
  // Assert exactly-one selector in the SERVICE (the zod `.refine` only guards the
  // tRPC boundary, but this fn is exported). Neither → `findFirst({ slug:
  // undefined })` would return an ARBITRARY approved row (enumeration footgun);
  // both → ambiguous. Fail closed to null in either case.
  if (!input.id === !input.slug) return null;
  // `revisionOfId: null` is NOT redundant. ⚠️ An earlier version of this comment called it
  // "defense-in-depth … already excluded by the approved-only check below" — there IS no
  // approved-only check below any more: the level gate replaced it, and that gate can admit
  // a non-approved row. A shadow revision is a draft, so this term is now the only thing
  // keeping a shadow's staged, un-reviewed content out of a public detail read. Do not
  // remove it as redundant; the grid's twin comment was corrected in this same change.
  const where: Prisma.AppListingWhereInput = input.id
    ? { id: input.id, revisionOfId: null }
    : { slug: input.slug, revisionOfId: null };

  const row = await dbRead.appListing.findFirst({
    where,
    // `connectRequestedScopes` spread in for the DETAIL only — see the note at
    // `listingHydrateSelect` for why it must not live in the grid-shared select.
    select: { ...listingHydrateSelect, status: true, connectRequestedScopes: true },
  });
  if (!row) return null;
  // LEVEL GATE, in the app layer (like the AppBlock path) so a future caller can't reuse
  // this for a non-public path: a row this viewer's cohort may not see returns null
  // exactly like a missing one — never its data, and never a distinguishable refusal.
  //
  // 🔴 THE LEVEL IS READ SEPARATELY, AND IT CANNOT BE READ ANY OTHER WAY. `visibility` is
  // `// @no-type` in `schema.full.prisma`, so it is stripped from the generated client and
  // does not exist on the `appListing` delegate — naming it in any `select` is a compile
  // error. Deliberate: as an ordinary field it was emitted by every default
  // SELECT/RETURNING, which 500d off-site submit on the PR preview during the manual-apply
  // window. The guarded reader uses raw SQL.
  //
  // 🔴 AND AN UNAVAILABLE COLUMN NEEDS NO SPECIAL CASE HERE. `readListingVisibility` catches
  // the missing column and answers `visibility: null`, which `listingVisibleInStore` already
  // resolves to the pre-feature rule for the status — approved visible, non-approved not. An
  // earlier revision branched on `available` to reach the same answer; that branch is gone
  // because the two states genuinely coincide, and one route is easier to keep true than two.
  const level = await readListingVisibility(row.id, dbRead);
  if (!listingVisibleInStore({ status: row.status, visibility: level.visibility, floor })) {
    return null;
  }
  // STORE-SCOPE kind gate (the public/onsite security boundary): under
  // `public-external` an ONSITE listing is indistinguishable from a missing one —
  // return null so no crafted id/slug can reach an onsite listing's detail. EVERY
  // offsite listing remains visible, OAuth-connected or not (gate on `kind`,
  // never `connectClientId`). `full` imposes no kind restriction (unchanged).
  if (scope === 'public-external' && row.kind !== 'offsite') return null;
  // DEPLOY-GATE (generic, all app-blocks): an ONSITE listing whose backing
  // AppBlock has NEVER successfully deployed is indistinguishable from a missing
  // one — its `<slug>.<APPS_DOMAIN>` origin would 404. `currentVersionDeployedAt`
  // is set only on a successful apply and stays set while a NEW version rebuilds,
  // so a live app mid-re-deploy is still shown. OFFSITE listings have no
  // AppBlock/deploy concept and are UNAFFECTED (discriminate on `kind`).
  if (row.kind === 'onsite' && row.appBlock?.currentVersionDeployedAt == null) return null;
  // Maturity gate off a non-red host: a mature listing is indistinguishable from
  // a missing one (mirrors the AppBlock detail's red-only 404).
  if (!redCapable && isMatureContentRating(row.contentRating)) return null;

  // All three extras run in PARALLEL with each other, so the public detail read still costs
  // ONE round trip more than the bare hydrate, not three. Each is separately guarded
  // against its own manual-apply migration being outstanding — the collaborator TABLE
  // (`safeCollaboratorQuery` → `[]`), the source-repo COLUMN (`readListingSourceRepoUrl` →
  // `{available:false, value:null}`) and the beta COLUMNS (`readListingBetaForRender` →
  // `BETA_UNAVAILABLE` on ANY error, because a cosmetic label must not 500 a public page).
  const [collaborators, sourceRepo, beta] = await Promise.all([
    loadDisplayedCollaboratorChips(row.id),
    readListingSourceRepoUrl(row.id, dbRead),
    readListingBetaForRender(row.id, dbRead),
  ]);
  return projectListingDetail(
    row,
    collaborators,
    sourceRepo.value,
    beta,
    row.connectRequestedScopes
  );
}

/**
 * Hydrate the PUBLIC collaborator byline for a listing: its ACCEPTED **and**
 * `displayed` collaborators, projected to the same `{id, username, image}` allowlist as
 * the creator chip.
 *
 * 🔴 KEYED ON THE LISTING, so it works for BOTH kinds. This read is the whole point of
 * the block→listing re-key: an OFF-SITE listing has no AppBlock, so while seats were
 * block-keyed its byline could only ever be empty.
 *
 * 🔴 CONSENT + OPT-IN, both load-bearing (enforced in `listDisplayedCollaboratorUserIds`):
 * a PENDING invitee must never appear publicly — otherwise anyone could attach a
 * stranger's name to their listing simply by inviting them — and an accepted
 * collaborator who opted out of the byline must not appear either.
 *
 * Returns `[]` when the manual-apply migration has not landed — so the public read is
 * byte-identical to today until both the table and a seat exist. The caller only ever
 * passes a PARENT listing id (shadow revisions are filtered out of every public read),
 * which is also the only id a seat can exist under.
 */
async function loadDisplayedCollaboratorChips(
  appListingId: string | null
): Promise<Array<{ id: number; username: string | null; image: string | null }>> {
  if (!appListingId) return [];
  const { listDisplayedCollaboratorUserIds } = await import(
    '~/server/services/blocks/app-access.service'
  );
  const userIds = await listDisplayedCollaboratorUserIds(appListingId);
  if (userIds.length === 0) return [];
  // 🔴 EXPLICIT ALLOWLIST at the SELECT, not only at the projection. Two independent
  // narrowings: nothing but these four columns ever leaves the DB, and `creatorChip`
  // re-shapes them. Widening either alone cannot leak.
  // 🔴 BANNED AND DELETED ACCOUNTS ARE FILTERED OUT, EXPLICITLY.
  //
  // This is the read that puts a collaborator's name and avatar on a PUBLIC app page,
  // linked to their profile. Without these two clauses a banned user keeps that placement
  // indefinitely, and a deleted one fell out only INCIDENTALLY — `deleteUser` is a SOFT
  // delete that nulls `username` in the same transaction as `deletedAt`, and the chip
  // component skips username-less rows, which is luck, not a filter. (This comment said
  // "a hard delete" until 2026-10-04; there is no hard-delete path in `user.service.ts`,
  // and the distinction matters because the luck is the PII scrub, not row removal.)
  // Neither is something to leave to the render layer.
  //
  // 🔴 DELIBERATELY STRICTER THAN `creatorChip`, which has the same shape and is NOT
  // changed here. The two are different subjects: the creator IS the app's owner, whose
  // ban delists the app anyway, so their chip and the listing disappear together. A
  // COLLABORATOR is a third party — banning them must not require touching an app that
  // may be perfectly healthy and owned by someone else entirely.
  const users = await dbRead.user.findMany({
    where: { id: { in: userIds }, bannedAt: null, deletedAt: null },
    // `deletedAt` is projected even though the `where` already excludes deleted rows: it makes
    // this chip satisfy the user-chip guard outright rather than needing a ledger exemption,
    // and it costs nothing — the column is read from the same heap tuple, no extra rows.
    select: { id: true, username: true, deletedAt: true, image: true },
  });
  // Preserve the seat order (`createdAt asc`) rather than the DB's row order.
  const byId = new Map(users.map((u: { id: number }) => [u.id, u]));
  return userIds
    .map((id) => byId.get(id))
    .filter(
      (u): u is { id: number; username: string | null; image: string | null } => u !== undefined
    );
}

// ---------------------------------------------------------------------------
// W13 POST-APPROVAL MOD MANAGEMENT — the moderator ALL-STATUS listings read.
//
// The mod management table's data source: listings across EVERY lifecycle status
// (draft|pending|approved|rejected|removed), with the fields the table + the
// per-row lifecycle actions need — NOT the public allowlist (this is mod-only, so
// it carries `status`, the owner chip, and the latest pending publish-request id
// so the Review action can open the existing off-site review modal). Keyset-
// paginated by the ULID `id` (a stable total order); mirrors the sibling mod-read
// queues' Prisma-cursor discipline. Shadow revision drafts are excluded.
// ---------------------------------------------------------------------------

/** A public creator/submitter chip (id/username/image only — the standard subset). */
export type ModerationUserChip = { id: number; username: string | null; image: string | null };

/** One row of the moderator all-status listings table (a single `AppListing`). */
export type ModerationListingRow = {
  id: string;
  slug: string;
  name: string;
  kind: ListingKind;
  status: string;
  category: string | null;
  contentRating: string | null;
  /** Off-site external-link target (for the review modal / a Visit affordance). */
  externalUrl: string | null;
  /** Backing AppBlock id (onsite), else null. */
  appBlockId: string | null;
  owner: ModerationUserChip | null;
  installCount: number;
  thumbsUpCount: number;
  thumbsDownCount: number;
  /**
   * The listing's LATEST pending publish request, when one exists (a pending
   * listing has one) — carries what the reused off-site review modal needs. Null
   * when nothing is pending review for this listing.
   */
  pendingRequest: {
    id: string;
    submittedAt: Date;
    changelog: string | null;
    /** The shared review chip — see the select. NOT `ModerationUserChip`, which is the
     *  listings table's own plain-text owner cell and carries no `deletedAt`. */
    submittedBy: ReviewSubmitterChip;
  } | null;
  /**
   * 🔴 ON-SITE ONLY, AND NOT THE SAME THING AS `pendingRequest`.
   *
   * `pendingRequest` above comes from the `AppListingPublishRequest` relation, whose
   * `appListingId` the schema documents as "On-site: NULL until approve". So for an on-site
   * PRE-APPROVAL DRAFT it is `null` no matter what — the live submission behind that row is an
   * `AppBlockPublishRequest`, joined to the listing by the shared `@unique` SLUG and by no
   * foreign key at all.
   *
   * This flag is that missing signal, resolved by a slug-keyed lookup. Without it the table
   * cannot tell an ABANDONED draft from one under active review, and offered the destructive
   * Purge action on both. Always `false` for an off-site row (whose requests do carry the FK).
   */
  hasPendingBlockRequest: boolean;
  /**
   * The author's beta declaration, so a moderator can SEE it.
   *
   * 🔴 A moderator cannot review what the store never shows them. Beta is a TRIVIAL patch
   * field — an author edits it in place with no re-review — so this table is the only
   * moderator surface on which the declaration and its free-text note appear at all, and
   * the delist/takedown actions in this same table are the remedy for an abusive one.
   *
   * Both `false`/`null` while the MANUAL-APPLY migration is outstanding — resolved through
   * the guarded batch read, never named in `moderationListingSelect`.
   */
  isBeta: boolean;
  betaMessage: string | null;
};

/**
 * The Prisma `select` for a moderation-table row. Includes `status` + the owner
 * chip + the metric counts + the SINGLE latest pending publish request (the
 * Review action's `publishRequestId` + the fields to build the modal's row).
 */
export const moderationListingSelect = {
  id: true,
  slug: true,
  name: true,
  kind: true,
  status: true,
  category: true,
  contentRating: true,
  externalUrl: true,
  appBlockId: true,
  user: { select: { id: true, username: true, image: true } },
  metric: { select: { installCount: true, thumbsUpCount: true, thumbsDownCount: true } },
  publishRequests: {
    where: { status: 'pending' },
    orderBy: { submittedAt: 'desc' },
    take: 1,
    select: {
      id: true,
      submittedAt: true,
      changelog: true,
      // 🔴 THE SHARED REVIEW CHIP, because this row reaches a REVIEW surface: it is handed to
      // the reused off-site review modal, which is the same modal the review queue opens.
      //
      // ⚠️ FORWARD-LOOKING, AND AN EARLIER VERSION OF THIS COMMENT OVERSTATED IT. That version
      // said the modal "renders the submitter through `UserAvatar` — and that BRANCHES on
      // `deletedAt`". It does not, today: `OffsiteReviewQueue` renders the submitter as plain
      // `{username ?? '#id'}` text and does not import `UserAvatar` at all, so a closed
      // account currently shows its verbatim username there and there is no profile link to
      // suppress. The field is carried so the chip MATCHES every other review read and the
      // branch is available the moment that cell adopts the shared component — which is the
      // stated direction, and the on-site half of the same list already made the move. Read
      // at face value the old wording answered "does this surface handle a deleted account?"
      // with a confident yes, which is how a gap stays closed to inspection.
      //
      // The `user` chip above is deliberately NOT widened: it is the listings table's own
      // owner cell, plain text, and a separate decision about a separate screen.
      submittedBy: { select: reviewUserChipSelect },
    },
  },
} satisfies Prisma.AppListingSelect;

type HydratedModerationRow = Prisma.AppListingGetPayload<{
  select: typeof moderationListingSelect;
}>;

/**
 * Project a hydrated moderation row → the {@link ModerationListingRow} DTO.
 *
 * `pendingBlockRequestSlugs` is the set of slugs with a live `AppBlockPublishRequest`,
 * resolved by the caller in one batched query (there is no FK to include). A caller that
 * cannot resolve it passes an empty set — see the 🔴 note on `hasPendingBlockRequest`, and
 * note that an empty set is the PERMISSIVE direction, so only the mod-table read (which does
 * resolve it) may drive a destructive affordance from this field.
 */
export function projectModerationListing(
  row: HydratedModerationRow,
  pendingBlockRequestSlugs: ReadonlySet<string> = new Set(),
  beta: ListingBetaRead = BETA_NOT_SET
): ModerationListingRow {
  const pending = row.publishRequests[0] ?? null;
  return {
    // 🔴 The note is carried ONLY when the flag is set — the same rule the public detail
    // projection applies, and for the same reason: a stale note from an author who turned
    // beta off is not something this table should show as current.
    isBeta: beta.isBeta,
    betaMessage: beta.isBeta ? beta.betaMessage : null,
    hasPendingBlockRequest: row.kind === 'onsite' && pendingBlockRequestSlugs.has(row.slug),
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind as ListingKind,
    status: row.status,
    category: row.category ?? null,
    contentRating: row.contentRating ?? null,
    externalUrl: row.externalUrl ?? null,
    appBlockId: row.appBlockId ?? null,
    owner: creatorChip(row.user),
    installCount: row.metric?.installCount ?? 0,
    thumbsUpCount: row.metric?.thumbsUpCount ?? 0,
    thumbsDownCount: row.metric?.thumbsDownCount ?? 0,
    pendingRequest: pending
      ? {
          id: pending.id,
          submittedAt: pending.submittedAt,
          changelog: pending.changelog ?? null,
          // 🔴 PASSED THROUGH WHOLE, not through `creatorChip`. That helper projects
          // `{ id, username, image }` EXPLICITLY, so it would drop the `deletedAt` the
          // select above exists to carry — a field the review modal branches on. An
          // explicit re-projection is exactly how this class of defect travels one layer
          // at a time, and it produces no type error on the way.
          submittedBy: pending.submittedBy,
        }
      : null,
  };
}

/**
 * The Prisma `where` fragment for the mod table's status filter, made
 * EFFECTIVE-STATUS-AWARE so display and filter agree on "awaiting first review".
 *
 * An external listing awaiting its FIRST review is stored as `status='draft'`
 * with a live pending publish request (see {@link effectiveModerationStatus}).
 *
 *   - undefined (all) → `{}` (no status constraint)
 *   - 'pending'       → real-pending OR a draft WITH a live pending request
 *   - 'draft'         → only TRUE orphan drafts (a draft with NO pending request,
 *                        so a draft-with-pending isn't double-listed under Draft)
 *   - anything else   → an exact `{ status }` match
 *
 * Pure, total. Returned as its own fragment so the caller composes it under `AND`
 * (this clause may itself be an `OR`, which would collide with the `search` `OR`).
 */
export function moderationStatusWhere(status: string | undefined): Prisma.AppListingWhereInput {
  if (!status) return {};
  if (status === 'pending') {
    return {
      OR: [
        { status: 'pending' },
        { status: 'draft', publishRequests: { some: { status: 'pending' } } },
      ],
    };
  }
  if (status === 'draft') {
    return { status: 'draft', publishRequests: { none: { status: 'pending' } } };
  }
  return { status };
}

/**
 * List listings across ALL lifecycle statuses for the mod management table.
 * Filters (all optional): `status`, `kind`, and a server-side `search` over
 * name/slug (case-insensitive). Keyset-paginated by the ULID `id` DESC (newest
 * first, a stable total order — the opaque cursor is the last row's id); bounded
 * to 50. Shadow revision drafts (`revisionOfId != null`) are never surfaced.
 */
export async function listAllListingsForModeration(
  input: ListAllListingsForModerationInput
): Promise<{ items: ModerationListingRow[]; nextCursor: string | null }> {
  const limit = Math.min(input.limit ?? 25, 50);
  const search = input.search?.trim();

  // Both the status filter and the search may each be an `OR` clause — composing
  // them via `AND` (dropping the empty ones) keeps both `OR`s alive instead of one
  // overwriting the other's `OR` key on the object.
  const statusClause = moderationStatusWhere(input.status);
  const searchClause: Prisma.AppListingWhereInput = search
    ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { slug: { contains: search, mode: 'insensitive' } },
        ],
      }
    : {};

  const where: Prisma.AppListingWhereInput = {
    // Never surface a SHADOW revision draft as its own row (mirrors the read path).
    revisionOfId: null,
    ...(input.kind ? { kind: input.kind } : {}),
    AND: [statusClause, searchClause].filter((c) => Object.keys(c).length > 0),
  };

  const rows = await dbRead.appListing.findMany({
    where,
    // `id` is `apl_<ULID>` → lexicographically creation-ordered, so `id DESC` is
    // both "newest first" AND a stable total keyset (id is unique).
    orderBy: { id: 'desc' },
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: moderationListingSelect,
  });

  const hasNext = rows.length > limit;
  const page = hasNext ? rows.slice(0, limit) : rows;

  // 🔴 The on-site "is this draft under review?" signal, which no `include` can supply: an
  // on-site `AppBlockPublishRequest` is joined to its listing by the shared `@unique` SLUG
  // and carries no FK (`AppListingPublishRequest.appListingId` is "On-site: NULL until
  // approve"). One batched query over just this page's on-site slugs, so it stays O(1) reads
  // regardless of page size and costs nothing on an all-off-site page.
  const onsiteSlugs = page.filter((r) => r.kind === 'onsite').map((r) => r.slug);
  const pendingBlockRequestSlugs = new Set<string>(
    onsiteSlugs.length
      ? (
          await dbRead.appBlockPublishRequest.findMany({
            where: { slug: { in: onsiteSlugs }, status: 'pending' },
            select: { slug: true },
          })
        ).map((r: { slug: string }) => r.slug)
      : []
  );

  // ONE batched guarded read for this page's beta declaration — never a column in
  // `moderationListingSelect`, which would 500 the whole mod table until a human runs the
  // migration. Same O(1)-per-page shape as the on-site pending-request lookup above.
  const betaById = await readListingBetaManyForRender(
    page.map((r: { id: string }) => r.id),
    dbRead
  );

  const items = page.map((r) =>
    projectModerationListing(r, pendingBlockRequestSlugs, betaById.get(r.id) ?? BETA_NOT_SET)
  );
  return { items, nextCursor: hasNext ? items[items.length - 1].id : null };
}
