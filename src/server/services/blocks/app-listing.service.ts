import { Prisma } from '@prisma/client';

import { getEdgeUrl } from '~/client-utils/edge-url';
import { env } from '~/env/server';
import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { toPublicBlockManifest } from '~/server/schema/blocks/subscription.schema';
import { isMatureContentRating } from '~/server/utils/server-domain';
import type { StoreVisibilityScope } from '~/server/services/app-blocks-flag';
import { narrowStoreScope } from '~/shared/utils/store-visibility-scope';
import type {
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
// The MANUAL-APPLY `source_repo_url` column is read ONLY through this guard — never via
// `listingHydrateSelect`, which the public `/apps` GRID shares. See its module header.
import { readListingSourceRepoUrl } from '~/server/services/blocks/app-listing-source-repo.service';
// The MANUAL-APPLY `is_beta` / `beta_message` columns are read ONLY through this guard —
// never via `listingHydrateSelect` or `moderationListingSelect`, for the same reason. See
// its module header.
import {
  BETA_NOT_SET,
  readListingBetaForRender,
  readListingBetaManyForRender,
  type ListingBetaRead,
} from '~/server/services/blocks/app-listing-beta.service';
import { queryCache } from '~/server/utils/cache-helpers';

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
  appBlock: { select: { manifest: true, currentVersionDeployedAt: true } },
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
 * 🔴 MERGE-ORDER CONSTRAINT — READ BEFORE SHIPPING THE RENDERER (Stage 4).
 * NOTHING WRITES `open_count` YET. `appListing.metrics.sql.ts` populates `install_count`
 * only — its own suite asserts `expect(upsert).not.toContain('open_count')` — and no
 * other writer exists, so this function returns a literal `0` for EVERY on-site listing
 * in production today. The DTO has no third state for "measurable but not yet
 * measured": `null` means unmeasurable and `0` means measured-as-none, and the honest
 * answer right now is neither.
 *
 * So the renderer MUST NOT merge before the rollup that populates the column (#4653),
 * or must gate the rendered stat row behind a flag until it lands. Shipping it first
 * makes the public `/apps` grid print "0 plays" on every on-site app INCLUDING heavily
 * used ones — by this field's own written standard the worst outcome available, and on
 * the public surface. The flag is deliberately NOT built here.
 */
function cardOpenCount(row: HydratedListing): number | null {
  if (row.kind !== 'onsite') return null;
  return row.metric?.openCount ?? 0;
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
    select: { ...listingHydrateSelect, revisionOfId: true },
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
    detail: projectListingDetail(row, [], sourceRepo.value, beta),
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
  beta: ListingBetaRead = BETA_NOT_SET
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
      // `name` is unbounded `text`; the RAW sort key is encoded into the base64
      // cursor, so a long name would overflow `cursor: z.string().max(128)` and
      // halt pagination (BAD_REQUEST). Bound the key to 64 chars — IDENTICAL in
      // SELECT + the keyset WHERE (same `expr`), so paging stays exact; `al.id`
      // remains the total-order tiebreak, so a 64-char-truncation collision
      // still paginates correctly.
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
    { ttl: CacheTTL.hour, tag: ['app-listing:recommend-global-mean'] }
  );
  return rows[0]?.mean ?? DEFAULT_RECOMMEND_MEAN;
}

// ---------------------------------------------------------------------------
// Read procs (over BOTH kinds, approved-only, public allowlist).
// ---------------------------------------------------------------------------

/**
 * List approved listings of BOTH kinds for the unified store. Keyset-paginated
 * over a computed `sort_key`; the row-value tuple `(sort_key, id)` is a total
 * keyset so a paged scan stays stable even across tied sort values.
 *
 * Two-step: a raw keyset query resolves the ORDERED, filtered page of ids
 * (joining the metric rollup for the sort), then a single Prisma hydration
 * fetches the public projection fields and we re-apply the raw order. This keeps
 * the projection type-safe + testable while the sort/keyset stays exact.
 */
export async function listAvailableListings(
  input: ListAppListingsInput,
  opts: { redCapable?: boolean; scope?: StoreVisibilityScope } = {}
): Promise<{ items: ListingCard[]; nextCursor?: string }> {
  const { kind, category, sort, cursor, limit } = input;
  const redCapable = opts.redCapable ?? false;
  // 🔴 FAIL CLOSED on an absent / unrecognized scope (civitai#3983). This used to be
  // `opts.scope ?? 'full'`, on the reasoning that every caller passes an explicit
  // scope. Every caller does — and production still reached here with `undefined`,
  // so the `??` fired and this function served the WHOLE approved catalog (on-site
  // apps included) to anonymous callers of the public REST endpoint. A default is an
  // authorization decision; the only safe one here is `none` → `FALSE` predicate →
  // an empty page. `narrowStoreScope` is the single shared rule; see
  // `~/shared/utils/store-visibility-scope`.
  const scope = narrowStoreScope(opts.scope);

  const { cursorSortKey, cursorId, cursorMean } = decodeListingCursor(cursor);

  // Only `top-rated` needs the global mean. PIN it into the cursor across a
  // paging session (page 1 reads the 1h cache + encodes it; pages 2..N reuse
  // the pinned value, NOT a fresh read) so the sort key can't shift mid-scan.
  const globalMean = sort === 'top-rated' ? cursorMean ?? (await getGlobalRecommendMean()) : 0;

  const { expr: sortKeyExpr, descending } = listingSortKeyExpr(sort, globalMean);
  const dir = descending ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  const keysetCmp = descending ? Prisma.sql`<` : Prisma.sql`>`;
  const kindParam = kind === 'all' ? null : kind;
  const categoryParam = category ?? null;

  const idRows = await dbRead.$queryRaw<{ id: string; sort_key: string }[]>(Prisma.sql`
    SELECT al.id, ${sortKeyExpr} AS sort_key
    FROM app_listings al
    LEFT JOIN app_listing_metrics m ON m.app_listing_id = al.id
    -- DEPLOY-GATE: join the backing AppBlock (onsite only) so we can require it
    -- has actually deployed its slug origin before listing it.
    LEFT JOIN app_blocks ab ON ab.id = al.app_block_id
    WHERE al.status = 'approved'
      -- Never surface a SHADOW revision draft. Shadows are status='draft' so the
      -- approved-only filter already hides them; this is defense-in-depth.
      AND al.revision_of_id IS NULL
      -- DEPLOY-GATE (generic, all app-blocks): an ONSITE (block-backed) listing
      -- only appears once its backing AppBlock has SUCCESSFULLY deployed at least
      -- once (current_version_deployed_at set on a successful apply, left NULL
      -- while first-building). A re-deploying app keeps its non-null timestamp,
      -- so it stays listed. OFFSITE listings have no AppBlock/deploy concept and
      -- are UNAFFECTED (kind discriminates, never appBlockId nullness).
      AND (al.kind <> 'onsite' OR ab.current_version_deployed_at IS NOT NULL)
      AND (${kindParam}::text IS NULL OR al.kind = ${kindParam}::text)
      AND (${categoryParam}::text IS NULL OR al.category = ${categoryParam}::text)
      AND ${listingMatureFilter(redCapable)}
      -- STORE-SCOPE kind gate: full scope emits TRUE (unchanged); public-external
      -- emits offsite-only (onsite excluded) -- the whole public/onsite boundary.
      AND ${listingPublicVisibilityFilter(scope)}
      AND (
        ${cursorSortKey}::text IS NULL
        OR (${sortKeyExpr}, al.id) ${keysetCmp} (${cursorSortKey}::text, ${cursorId}::text)
      )
    ORDER BY sort_key ${dir}, al.id ${dir}
    LIMIT ${limit + 1}
  `);

  const trimmed = idRows.slice(0, limit);
  const last = trimmed[trimmed.length - 1];
  const pinnedMean = sort === 'top-rated' ? globalMean : undefined;
  const nextCursor =
    idRows.length > limit && last
      ? encodeListingCursor(last.sort_key, last.id, pinnedMean)
      : undefined;

  if (trimmed.length === 0) return { items: [], nextCursor: undefined };

  // Hydrate the public projection for the page, then re-apply the keyset order
  // (findMany does not preserve the `IN (...)` order).
  const pageIds = trimmed.map((r: { id: string; sort_key: string }) => r.id);
  // 🔴 IN PARALLEL WITH THE HYDRATE, not after it. Both are keyed on `pageIds`, which is
  // already in hand, so the beta read depends on nothing the hydrate produces — running them
  // serially would add a whole round trip to the public `/apps` grid for a cosmetic badge.
  // ONE batched read for the page, so it stays O(1) queries regardless of page size, and it
  // is the `…ForRender` variant: a failure renders every card as not-beta rather than 500ing
  // the grid, which is exactly what this module's header says must not happen.
  const [hydrated, betaById] = await Promise.all([
    dbRead.appListing.findMany({
      where: { id: { in: pageIds } },
      select: listingHydrateSelect,
    }),
    readListingBetaManyForRender(pageIds, dbRead),
  ]);
  const byId = new Map(hydrated.map((r: HydratedListing): [string, HydratedListing] => [r.id, r]));
  const items = pageIds
    .map((id: string) => byId.get(id))
    .filter((r): r is HydratedListing => r != null)
    // 🔴 `?? BETA_NOT_SET`, not `?? BETA_UNAVAILABLE`: a row present in `hydrated` but
    // absent from the beta map means the columns WERE readable and that listing simply had
    // no row when the second query ran. Both project as not-beta, but only the former is an
    // honest description of what happened.
    .map((r) => projectListingCard(r, betaById.get(r.id) ?? BETA_NOT_SET));

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
  opts: { redCapable?: boolean; scope?: StoreVisibilityScope } = {}
): Promise<ListingDetail | null> {
  const redCapable = opts.redCapable ?? false;
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
  // `revisionOfId: null` is defense-in-depth: a shadow is status='draft' (already
  // excluded by the approved-only check below), but never let a crafted id reach a
  // shadow's data through this public read.
  const where: Prisma.AppListingWhereInput = input.id
    ? { id: input.id, revisionOfId: null }
    : { slug: input.slug, revisionOfId: null };

  const row = await dbRead.appListing.findFirst({
    where,
    select: { ...listingHydrateSelect, status: true },
  });
  // Status check in the app layer (like the AppBlock path) so a future caller
  // can't reuse this for a non-public path: a non-approved row returns null
  // exactly like a missing one — never its data.
  if (!row || row.status !== 'approved') return null;
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
  return projectListingDetail(row, collaborators, sourceRepo.value, beta);
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
  // narrowings: nothing but these three columns ever leaves the DB, and `creatorChip`
  // re-shapes them. Widening either alone cannot leak.
  // 🔴 BANNED AND DELETED ACCOUNTS ARE FILTERED OUT, EXPLICITLY.
  //
  // This is the read that puts a collaborator's name and avatar on a PUBLIC app page,
  // linked to their profile. Without these two clauses a banned user keeps that placement
  // indefinitely, and a deleted one fell out only INCIDENTALLY — a hard delete nulls
  // `username` and the chip component skips username-less rows, which is luck, not a
  // filter. Neither is something to leave to the render layer.
  //
  // 🔴 DELIBERATELY STRICTER THAN `creatorChip`, which has the same shape and is NOT
  // changed here. The two are different subjects: the creator IS the app's owner, whose
  // ban delists the app anyway, so their chip and the listing disappear together. A
  // COLLABORATOR is a third party — banning them must not require touching an app that
  // may be perfectly healthy and owned by someone else entirely.
  const users = await dbRead.user.findMany({
    where: { id: { in: userIds }, bannedAt: null, deletedAt: null },
    select: { id: true, username: true, image: true },
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
    submittedBy: ModerationUserChip | null;
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
      submittedBy: { select: { id: true, username: true, image: true } },
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
          submittedBy: creatorChip(pending.submittedBy),
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
