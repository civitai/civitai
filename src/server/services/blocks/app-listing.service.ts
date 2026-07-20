import { Prisma } from '@prisma/client';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { env } from '~/env/server';
import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { toPublicBlockManifest } from '~/server/schema/blocks/subscription.schema';
import { isMatureContentRating } from '~/server/utils/server-domain';
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
  OffsiteSubKind,
} from '~/server/schema/blocks/app-listing-read.schema';
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
 * many-review 95% app. Mirrors the AppBlock rating sort's `BAYES_MIN_REVIEWS`.
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

/** Off-site sub-kind: OAuth-connect when a connect client is set, else external-link. */
export function resolveOffsiteSubKind(connectClientId: string | null | undefined): OffsiteSubKind {
  return connectClientId ? 'connect' : 'external-link';
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

/** Build a CDN icon URL from an icon Image row (or null). */
function iconUrl(icon: { url: string | null } | null | undefined): string | null {
  return icon?.url ? getEdgeUrl(icon.url, { width: 256 }) : null;
}

/** Cover URL = the cover Image, else the first screenshot's Image, else null. */
function coverUrl(
  cover: { url: string | null } | null | undefined,
  firstScreenshotUrl: string | null
): string | null {
  if (cover?.url) return getEdgeUrl(cover.url, { width: 1200 });
  return firstScreenshotUrl;
}

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
  metric: { select: { thumbsUpCount: true, thumbsDownCount: true } },
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
      subKind: resolveOffsiteSubKind(row.connectClientId),
      externalUrl: safeExternalUrl(row.externalUrl),
    };
  }
  return {
    kind: 'onsite',
    appBlockId: row.appBlockId ?? null,
    hasPage: manifestHasPage(row.appBlock?.manifest),
  };
}

/** Project a hydrated listing row → the PUBLIC card DTO (allowlist). */
export function projectListingCard(row: HydratedListing): ListingCard {
  const recommend = recommendRollup(row.metric);
  return {
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
    kindData: cardKindData(row),
  };
}

function detailKindData(row: HydratedListing): ListingDetailKindData {
  if (row.kind === 'offsite') {
    const subKind = resolveOffsiteSubKind(row.connectClientId);
    return {
      kind: 'offsite',
      subKind,
      externalUrl: safeExternalUrl(row.externalUrl),
      // The OAuth client_id is public (it's sent in the connect URL); the secret
      // is never selected here. Null for an external-link listing.
      connectClientId: subKind === 'connect' ? row.connectClientId ?? null : null,
    };
  }
  return {
    kind: 'onsite',
    appBlockId: row.appBlockId ?? null,
    hasPage: manifestHasPage(row.appBlock?.manifest),
    // Already-public standalone origin (no token/scope) — same host the webhook
    // validates the bundle's iframe against. Built from slug + APPS_DOMAIN.
    liveUrl: `https://${row.slug}.${env.APPS_DOMAIN}`,
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

/** Project a hydrated listing row → the PUBLIC detail DTO (allowlist). */
export function projectListingDetail(row: HydratedListing): ListingDetail {
  const recommend = recommendRollup(row.metric);
  return {
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
  opts: { redCapable?: boolean } = {}
): Promise<{ items: ListingCard[]; nextCursor?: string }> {
  const { kind, category, sort, cursor, limit } = input;
  const redCapable = opts.redCapable ?? false;

  const { cursorSortKey, cursorId, cursorMean } = decodeListingCursor(cursor);

  // Only `top-rated` needs the global mean. PIN it into the cursor across a
  // paging session (page 1 reads the 1h cache + encodes it; pages 2..N reuse
  // the pinned value, NOT a fresh read) so the sort key can't shift mid-scan.
  const globalMean =
    sort === 'top-rated' ? cursorMean ?? (await getGlobalRecommendMean()) : 0;

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
  const pageIds = trimmed.map((r) => r.id);
  const hydrated = await dbRead.appListing.findMany({
    where: { id: { in: pageIds } },
    select: listingHydrateSelect,
  });
  const byId = new Map(hydrated.map((r) => [r.id, r]));
  const items = pageIds
    .map((id) => byId.get(id))
    .filter((r): r is HydratedListing => r != null)
    .map(projectListingCard);

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
  opts: { redCapable?: boolean } = {}
): Promise<ListingDetail | null> {
  const redCapable = opts.redCapable ?? false;
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

  return projectListingDetail(row);
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

type HydratedModerationRow = Prisma.AppListingGetPayload<{ select: typeof moderationListingSelect }>;

/** Project a hydrated moderation row → the {@link ModerationListingRow} DTO. */
export function projectModerationListing(row: HydratedModerationRow): ModerationListingRow {
  const pending = row.publishRequests[0] ?? null;
  return {
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

  const where: Prisma.AppListingWhereInput = {
    // Never surface a SHADOW revision draft as its own row (mirrors the read path).
    revisionOfId: null,
    ...(input.status ? { status: input.status } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { slug: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
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
  const items = page.map(projectModerationListing);
  return { items, nextCursor: hasNext ? items[items.length - 1].id : null };
}
