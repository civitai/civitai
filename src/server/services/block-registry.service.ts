import { Prisma } from '@prisma/client';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { redis, REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { manifestSettingsSchema } from '~/server/schema/blocks/manifest-settings.meta.schema';
import { SLUG_REGEX } from '~/server/schema/blocks/publish-request.schema';
import { BlockRevocation } from '~/server/services/block-revocation.service';
import {
  getPopularCheckpointForEcosystem,
  getRepresentativeBaseModel,
  validateBlockCheckpoint,
} from '~/server/services/blocks/checkpoint.service';
import { validateBlockSettings } from '~/server/services/blocks/settings-validator.service';
import { clampTunnelDeclaredScopes } from '~/server/services/blocks/dev-scoped-mint.service';
import {
  newBlockInstanceId,
  newBlockUserSubscriptionId,
} from '~/server/utils/app-block-ids';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type {
  AvailableBlock,
  ListAvailableInput,
  MarketplaceMeta,
  PublicAppDetail,
  SetMarketplaceMetaInput,
  SubscriptionRecord,
  SubscriptionScope,
} from '~/server/schema/blocks/subscription.schema';
import { MARKETPLACE_CATEGORIES } from '~/server/services/blocks/marketplace-categories.constants';
import { toPublicBlockManifest, toPublicScreenshots } from '~/server/schema/blocks/subscription.schema';
import { isLaunchSlot, PAGE_SLOT_ID } from '~/shared/constants/slot-registry';
import { isMatureContentRating } from '~/server/utils/server-domain';
import { CacheTTL } from '~/server/common/constants';
import { queryCache } from '~/server/utils/cache-helpers';
import { BAYES_MIN_REVIEWS } from '~/server/services/appBlockReview.service';

const CACHE_TTL_SECONDS = 60;
export const MAX_BLOCKS_PER_SLOT = 3;

/**
 * F-E E3 — how many approved scopes the marketplace LISTING projects onto each
 * card as the permission preview (`AvailableBlock.scopesSummary`). The detail
 * page (E2 getAppDetail) shows the FULL approved scope set; the card shows only
 * the first N so the grid stays compact. Public, display-safe (same disclosure
 * data E2 surfaces).
 */
export const MARKETPLACE_SCOPES_SUMMARY_LIMIT = 3;

/**
 * F-E E3 marketplace keyset cursor. Encodes the last row's `(sortKey, id)` plus
 * the pinned Bayesian mean `m` as a base64url string so the next page resumes
 * strictly after it (the sort key is embedded so a paged scan stays stable even
 * when many rows share a sort value, e.g. install_count=0). Opaque to the
 * client. We use a unit-separator (\x1f) — a char that can't appear in any of
 * our sort keys (zero-padded digits, a fixed-width timestamp, or a lowercased
 * name) nor in an app_block id nor a numeric mean — so the split is unambiguous.
 *
 * `m` PINNING (the `rating` sort): the sort key is computed from the global mean
 * `m`, which is read from a 1h cache that can expire/bust MID-PAGINATION. If
 * page 2 re-derived every row's key with a different `m` than page 1's cursor
 * was encoded with, the keyset boundary shifts and one row is silently skipped
 * or duplicated. So we PIN `m` into the cursor and reuse it for every page of a
 * paging session. Empty for sorts that don't use `m` (popular/newest/name).
 */
const CURSOR_SEPARATOR = String.fromCharCode(31); // unit separator (\x1f)
function encodeMarketplaceCursor(sortKey: string, id: string, pinnedMean?: number): string {
  // Only the `rating` sort pins a mean; other sorts emit the legacy 2-field
  // `sortKey␟id` cursor (no trailing separator) so their format is unchanged.
  const body =
    pinnedMean == null
      ? `${sortKey}${CURSOR_SEPARATOR}${id}`
      : `${sortKey}${CURSOR_SEPARATOR}${id}${CURSOR_SEPARATOR}${pinnedMean}`;
  return Buffer.from(body, 'utf8').toString('base64url');
}
function decodeMarketplaceCursor(cursor: string | undefined): {
  cursorSortKey: string | null;
  cursorId: string | null;
  /** The mean `m` pinned by the FIRST page of this session (null if absent). */
  cursorMean: number | null;
} {
  const empty = { cursorSortKey: null, cursorId: null, cursorMean: null };
  if (!cursor) return empty;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    // Malformed cursor → treat as first page (fail-open to a safe default).
    return empty;
  }
  // Split on the FIRST two separators: [sortKey, id, mean]. sortKey + id can't
  // contain \x1f (zero-padded digits / timestamp / lowercased name / app id),
  // so the first two indexOf hits are the field boundaries.
  const sep1 = decoded.indexOf(CURSOR_SEPARATOR);
  if (sep1 < 0) return empty;
  const sep2 = decoded.indexOf(CURSOR_SEPARATOR, sep1 + 1);
  // Legacy 2-field cursor (no pinned mean) — fail-open to an unpinned page.
  const cursorId = sep2 < 0 ? decoded.slice(sep1 + 1) : decoded.slice(sep1 + 1, sep2);
  const meanField = sep2 < 0 ? '' : decoded.slice(sep2 + 1);
  const meanNum = meanField === '' ? NaN : Number(meanField);
  return {
    cursorSortKey: decoded.slice(0, sep1),
    cursorId,
    cursorMean: Number.isFinite(meanNum) ? meanNum : null,
  };
}

// ---------------------------------------------------------------------------
// Marketplace reviews — aggregate SQL + Bayesian sort (F-E "marketplace").
// ---------------------------------------------------------------------------

/**
 * Correlated subquery: AVG(rating) over an app's AGGREGATE-ELIGIBLE reviews —
 * NOT mod-excluded AND NOT the app owner's own (self-review). NULL for a
 * 0-review app. The card number, the detail number, and the global-mean `m`
 * share this eligibility filter so they all agree (one source of truth).
 */
const AVG_RATING_SUBQUERY = Prisma.sql`(
  SELECT AVG(abr.rating)::float
  FROM app_block_reviews abr
  WHERE abr.app_block_id = ab.id
    AND NOT abr.exclude
    AND abr.user_id IS DISTINCT FROM oc."userId"
)`;

/** Correlated subquery: COUNT of aggregate-eligible reviews (same filter). */
const REVIEW_COUNT_SUBQUERY = Prisma.sql`(
  SELECT COUNT(*)::bigint
  FROM app_block_reviews abr
  WHERE abr.app_block_id = ab.id
    AND NOT abr.exclude
    AND abr.user_id IS DISTINCT FROM oc."userId"
)`;

/** Correlated subquery: SUM(rating) of aggregate-eligible reviews (same filter). */
const SUM_RATING_SUBQUERY = Prisma.sql`(
  SELECT COALESCE(SUM(abr.rating), 0)::float
  FROM app_block_reviews abr
  WHERE abr.app_block_id = ab.id
    AND NOT abr.exclude
    AND abr.user_id IS DISTINCT FROM oc."userId"
)`;

// Scale factor for encoding the [1,5] Bayesian score as a zero-padded sortable
// integer string. score * 1e6 → 7 digits max (5_000_000), lpad to 9 for headroom.
const BAYES_SCORE_SCALE = 1_000_000;
const BAYES_SCORE_PAD = 9;
const INSTALL_PAD = 20; // matches the `popular` sort's install-count padding

/**
 * The Bayesian-shrinkage `rating` sort key, as a single zero-padded sortable
 * TEXT (the same fragment reused IDENTICALLY in SELECT, the keyset WHERE, and
 * ORDER BY — if it drifts, keyset pagination silently skips rows).
 *
 *   score = (C*m + SUM(rating)) / (C + n)
 *     n = aggregate-eligible review count, m = global mean (param), C = prior.
 *   0-review apps → score = m (mid-pack, not buried).
 *
 * Encoded DESC: lpad(round(score*SCALE)) so a plain TEXT DESC compare orders by
 * score. Tiebreaker concatenated: equal scores fall back to install_count
 * (lpad), then `ab.id` (the row-value keyset's final component). The whole key
 * is one TEXT so the keyset tuple `(sort_key, id)` is a correct total order.
 */
function bayesianRatingSortKey(globalMean: number): Prisma.Sql {
  // score = (C*m + SUM) / (C + n). C and m are server constants/params (safe).
  const score = Prisma.sql`(
    (${BAYES_MIN_REVIEWS}::float * ${globalMean}::float + ${SUM_RATING_SUBQUERY})
    / (${BAYES_MIN_REVIEWS}::float + ${REVIEW_COUNT_SUBQUERY})
  )`;
  const installCount = Prisma.sql`(
    SELECT COUNT(DISTINCT bus.user_id) FROM block_user_subscriptions bus
    WHERE bus.app_block_id = ab.id
  )`;
  // NB: cast the pad-length args to ::int. Prisma binds the JS number
  // constants as bigint, and `lpad(text, bigint, unknown)` has no overload
  // (the signature is `lpad(text, integer, text)`) → the whole query 500s at
  // runtime with `function lpad(text, bigint, unknown) does not exist`. The
  // unit tests only assert the SQL string shape (/lpad/), so this slipped past
  // them and was caught by the preview smoke test hitting a real database.
  return Prisma.sql`(
    lpad(round(${score} * ${BAYES_SCORE_SCALE})::bigint::text, ${BAYES_SCORE_PAD}::int, '0')
    || lpad(${installCount}::text, ${INSTALL_PAD}::int, '0')
  )`;
}

/**
 * The global mean rating `m` across ALL aggregate-eligible app reviews (NOT
 * exclude AND not self-review), cached 1h. Falls back to the neutral mid-scale
 * (3.0) when there are no reviews yet (the marketplace is dark/empty), so a
 * 0-review world still produces a sane, stable sort.
 */
async function getGlobalMeanRating(): Promise<number> {
  const cacheable = queryCache(dbRead, 'getGlobalMeanRating', 'v1');
  const rows = await cacheable<{ mean: number | null }[]>(
    Prisma.sql`
      SELECT AVG(abr.rating)::float AS mean
      FROM app_block_reviews abr
      JOIN app_blocks ab ON ab.id = abr.app_block_id
      JOIN "OauthClient" oc ON oc.id = ab.app_id
      WHERE NOT abr.exclude
        AND abr.user_id IS DISTINCT FROM oc."userId"
    `,
    { ttl: CacheTTL.hour, tag: ['app-rating:global-mean'] }
  );
  return rows[0]?.mean ?? 3.0;
}

// Slot-reservation math lives in a client-safe module so the model-page SSR
// path (BlockRegistry.getSlotReservation, below) and the client slot
// (BlockSlotClient's loading placeholder) share one source of truth without
// dragging server-only imports into the client bundle. Re-exported here for
// callers that already import from this service.
export {
  CHROME_BAR_PX,
  computeSlotReservation,
  type SlotReservation,
} from '~/components/AppBlocks/slotReservation';
import { computeSlotReservation } from '~/components/AppBlocks/slotReservation';
import type { SlotReservation } from '~/components/AppBlocks/slotReservation';

export interface BlockInstallRecord {
  blockInstanceId: string;
  blockId: string;
  appId: string;
  /**
   * `app_blocks.id` for this install. Used by App Blocks buzz
   * attribution to stamp the specific app_block row that earned the
   * revenue share. Distinct from `blockId` (the manifest's block id,
   * not stable across versions of the same app block).
   */
  appBlockId: string;
  manifest: {
    iframe?: {
      src: string;
      minHeight: number;
      maxHeight: number | null;
      resizable: boolean;
      sandbox: string;
    };
    scopes?: string[];
    contentRating?: string;
    name?: string;
    renderMode?: 'iframe' | 'inline' | 'hybrid';
    [key: string]: unknown;
  };
  publisherSettings: Record<string, unknown>;
  enabled: boolean;
  renderMode: 'iframe' | 'inline';
  trustTier: 'unverified' | 'verified' | 'internal';
  /**
   * Publisher-configured default Checkpoint, joined from settings.
   * `defaultCheckpointVersionId` at write time. Anon-safe: contains no
   * user-specific information — the per-viewer override is delivered
   * through a separate session-gated query.
   * `null` when the publisher hasn't set one (LoRA installs that haven't
   * been configured yet) — also the case for misconfigured Checkpoint
   * installs that should never need this anyway.
   */
  defaultCheckpoint?: {
    versionId: number;
    modelId: number;
    modelName: string;
    versionName: string;
    baseModel: string;
  } | null;
}

interface ListForModelOpts {
  modelId: number;
  slotId: string;
  /**
   * The model's type (e.g. 'Checkpoint', 'LORA') used to filter platform
   * defaults whose `target_model_types` array constrains them. Optional —
   * when omitted, platform defaults with target_model_types are skipped
   * (fail-closed).
   */
  modelType?: string;
  /**
   * Model's NSFW level (browsingLevel.constants.ts ladder). Used to drop
   * blocks whose manifest.contentRating exceeds what's allowed for this
   * page. Omitting it defaults to the most restrictive ladder rung ('pg').
   */
  modelNsfwLevel?: number;
  /**
   * Current viewer's user id. Drives the `viewer_personal` subscription
   * branch in the UNION. When `null`/undefined the branch matches no rows
   * (anon viewers don't have viewer-personal subscriptions). When set,
   * caching is disabled for the call — viewer-specific results would
   * otherwise leak across users in the shared (modelId, slotId) cache key.
   */
  viewerUserId?: number | null;
  /**
   * NSFW-APP-RED-ONLY: true when the request is on a red-capable host
   * (`isHostForColor(host, 'red')`, computed in the router). When false (the
   * default — fail-closed), mature-rated (r/x) apps are dropped from the result,
   * EVEN on a cache hit (the shared (modelId, slotId) cache is host-agnostic, so
   * the filter is applied after the cache read to avoid cross-host leakage).
   * This stacks on top of the existing model-NSFW-level ceiling (maxRating):
   * a mature app must clear BOTH the model's nsfw ladder AND the host gate.
   */
  redCapable?: boolean;
}

// Ordered ratings for ladder comparisons. Each rating implies "and below."
// A block rated 'pg13' may render when the slot rating is 'pg13', 'r', or 'x';
// it must not render when the slot rating is 'g' or 'pg'.
const CONTENT_RATING_ORDER = ['g', 'pg', 'pg13', 'r', 'x'] as const;
type ContentRating = (typeof CONTENT_RATING_ORDER)[number];
const CONTENT_RATING_INDEX: Record<string, number> = Object.fromEntries(
  CONTENT_RATING_ORDER.map((r, i) => [r, i])
);

/**
 * Maps a model's NSFW level (browsingLevel.constants.ts ladder, powers of 2
 * starting at 1) to a content-rating cap. The exact mapping mirrors what
 * the model-card UI shows; revisit alongside the next NSFW-level redesign.
 *
 *  level 1   (PG)   → 'pg'
 *  level 2   (PG13) → 'pg13'
 *  level 4   (R)    → 'r'
 *  level 8+  (X+)   → 'x'
 *  default          → 'g' (most restrictive)
 */
function maxRatingForNsfwLevel(level: number | undefined): ContentRating {
  if (!level || level <= 1) return 'pg';
  if (level === 2) return 'pg13';
  if (level === 4) return 'r';
  if (level >= 8) return 'x';
  return 'g';
}

/**
 * Discriminated shape returned by {@link BlockRegistry.resolveBlockInstance}.
 * Normalises across all four id namespaces — `mbi_*`/`bki_*` (per-model
 * pinned subscription, the only path with source='install'), `pdb_*`
 * (platform default), `bus_pub_*` (blanket publisher sub), `bus_view_*`
 * (viewer sub) — so call sites can branch on `source` instead of
 * duplicating the precedence-ladder lookup logic.
 *
 * Field semantics:
 *  - `modelId` / `slotId` — server-validated against the source row's
 *    predicates (model owner for publisher subs, viewer match for viewer
 *    subs, target_model_types filter for platform defaults). Callers MUST
 *    use these (not the caller-supplied context) when stamping JWT claims
 *    or writing to the DB, since the source row is the source of truth.
 *  - `installedByUserId` — for `install` source this is the actual installer
 *    (may be NULL for the SET-NULL FK case). For `publisher_subscription`
 *    and `viewer_subscription` it's the subscription owner — that user is
 *    the "publisher" for settings-scope checks in the block-tokens path.
 *    For `platform_default` it is always NULL (no per-user owner).
 *  - `enabled` — always TRUE for synthetic sources (those rows are
 *    implicitly enabled by their existence; if disabled they wouldn't have
 *    been resolved).
 *  - `settings` — publisher's stored settings JSONB (for `install` and
 *    subscriptions) or `{}` (for `platform_default`).
 */
export type ResolvedBlockSource =
  | 'install'
  | 'platform_default'
  | 'publisher_subscription'
  | 'viewer_subscription'
  // W10 full-page app (`page_<appBlockId>`, entity=none). A page is stateless:
  // it has NO install row, NO model entity, and resolves directly from the
  // approved AppBlock (see resolvePageBlock). Used by the FIN-1
  // buzz-attribution re-derivation to bucket a page purchase as
  // `viewer_global` (SOURCE_TO_SCOPE in attribution-validator.service.ts).
  // `modelId` is the 0 sentinel for this source — a page never pins a model.
  | 'page';

export interface ResolvedBlockInstance {
  source: ResolvedBlockSource;
  modelId: number;
  slotId: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  installedByUserId: number | null;
  appBlock: {
    id: string;
    blockId: string;
    appId: string;
    status: string;
    manifest: Record<string, unknown>;
    approvedScopes: string[];
    app: { allowedScopes: number } | null;
    // DEPLOY-GATE: NULL ⇔ this app has NEVER successfully deployed its
    // `<slug>.<APPS_DOMAIN>` origin (set to now() ONLY on a successful apply in
    // build-callback.ts; left UNCHANGED on build failure/timeout AND while a
    // NEW version re-builds — the old version keeps serving). The token mint
    // requires this to be non-null so an approved-but-never-deployed app can't
    // be run against an origin that would 404.
    currentVersionDeployedAt: Date | null;
  };
}

interface InstallOpts {
  modelId: number;
  appBlockId: string;
  slotId: string;
  installedByUserId: number;
  settings?: Record<string, unknown>;
}

/**
 * W10 — the page block shape the token mint consumes. Mirrors the `appBlock`
 * sub-shape of {@link ResolvedBlockInstance} but carries NO modelId / install
 * row (a page is stateless, entity=none).
 */
export interface PageBlockResolution {
  appBlock: ResolvedBlockInstance['appBlock'];
}

/**
 * W10 — the page block shape the SSR route consumes: just enough to render the
 * full-bleed IframeHost (iframe.src + sandbox + trust tier) and mint a token
 * (appBlockId). Public-display fields only; never the raw stored manifest.
 */
export interface PageBlockSsr {
  appBlockId: string;
  blockId: string;
  appId: string;
  iframeSrc: string;
  sandbox: string;
  trustTier: 'unverified' | 'verified' | 'internal';
  name: string;
  pageTitle: string;
  /** #3/#6: the page manifest's declared scopes. The host computes the ACTUAL
   *  granted set (declared − missingScopes from the mint) for BLOCK_INIT, so the
   *  block sees the real scopes it has rather than a hardcoded empty array. */
  scopes: string[];
  /** NSFW-APP-RED-ONLY: the authoritative content rating (app_blocks.content_rating
   *  column, set on approve). The SSR run-page gate 404s a mature (r/x) page app
   *  when the request host is not red-capable. NULL for pre-feature rows → SFW. */
  contentRating: string | null;
}

/**
 * APP DEV TUNNEL — the caller's OWN app resolved for the `/apps/dev/<blockId>`
 * route, at ANY status (pending/draft/approved/rejected). DISTINCT from
 * PageBlockSsr in TWO load-bearing ways:
 *   - it is OWNERSHIP-SCOPED (resolves only the caller's own app; null for
 *     another author's app — see resolveDevPageBlockForAuthor), and
 *   - it carries NO iframeSrc: the dev route's iframe points at the ephemeral
 *     tunnel host (server-derived), NEVER the manifest's stored iframe.src. This
 *     is why it can never resolve or serve a deployed `<slug>.civit.ai` bundle.
 */
export interface DevPageBlockResolution {
  appBlockId: string;
  blockId: string;
  appId: string;
  status: string;
  trustTier: 'unverified' | 'verified' | 'internal';
  name: string;
  pageTitle: string;
  sandbox: string;
  scopes: string[];
  contentRating: string | null;
  /** For an `ephemeral` resolution only: which scope source produced `scopes` —
   *  `'pending'` (the caller's own submitted-but-unapproved manifest) or
   *  `'brand-new'` (a truly-unclaimed slug, scopes from the dev-tunnel session).
   *  Undefined for the owned-approved path. Used for the mint-time audit log. */
  ephemeralSource?: 'pending' | 'brand-new';
}

interface UninstallOpts {
  modelId: number;
  appBlockId: string;
  slotId: string;
}

interface ToggleOpts {
  modelId: number;
  appBlockId: string;
  slotId: string;
  enabled: boolean;
}

interface UpdateSettingsOpts {
  blockInstanceId: string;
  /**
   * Server-resolved modelId. Audit B3: the previous `updateMany` keyed only
   * on blockInstanceId would, under the B2 TOCTOU window, let a former owner
   * write to an install on a model they no longer own. Pinning modelId in
   * the WHERE means even a stale auth window can't cross models.
   */
  modelId: number;
  settings: Record<string, unknown>;
}

type BlockRegistryKey = `${typeof REDIS_KEYS.BLOCKS.REGISTRY}:${number}:${string}`;

function cacheKey(modelId: number, slotId: string): BlockRegistryKey {
  return `${REDIS_KEYS.BLOCKS.REGISTRY}:${modelId}:${slotId}`;
}

async function invalidateModelCache(modelId: number) {
  const pattern = `${REDIS_KEYS.BLOCKS.REGISTRY}:${modelId}:*`;
  try {
    for await (const batch of redis.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      const keys = (Array.isArray(batch) ? batch : [batch]) as BlockRegistryKey[];
      if (keys.length === 0) continue;
      await redis.del(keys);
    }
  } catch {
    // fail open — cache will expire within CACHE_TTL_SECONDS
  }
}

// M3 (audit-10): every listForModel call does a fresh sysRedis sMembers
// round-trip — and a model page renders multiple slots concurrently, so
// each render hits sysRedis once per slot. The kill list itself is tiny
// and changes only on explicit ops action; a 5s in-process cache trims
// the steady-state load without compromising the emergency-revocation
// latency users actually care about.
const KILL_LIST_CACHE_TTL_MS = 5_000;
type KillListCache = { value: Set<string>; expiresAt: number };
let killListCache: KillListCache | null = null;

async function getKillList(): Promise<Set<string>> {
  const now = Date.now();
  const cached = killListCache;
  if (cached && cached.expiresAt > now) return cached.value;
  try {
    const members = await sysRedis.sMembers(REDIS_SYS_KEYS.BLOCKS.EMERGENCY_KILL_LIST);
    const value = new Set(members ?? []);
    killListCache = { value, expiresAt: now + KILL_LIST_CACHE_TTL_MS };
    return value;
  } catch (err) {
    // M-7 (audit): the emergency kill switch is the ops tool for an
    // already-launched runaway block. If sysRedis is unreachable, the
    // *correct* fail mode is loud, not silent. We can't synchronously
    // page from this hot path, so the next best thing is a console.error
    // (Axiom-collected) and a special sentinel that callers treat as
    // "suppress everything" — i.e. fail-closed. The launch-time feature
    // flag and per-block kill list serve complementary roles; on a
    // kill-list outage the block surface vanishes for the cache TTL
    // window (60s) until sysRedis recovers.
    // eslint-disable-next-line no-console
    console.error('[BlockRegistry] kill-list unreachable; failing closed', err);
    return new Set(['__KILL_LIST_UNREACHABLE__']);
  }
}

/**
 * Mirrors the `manifest @> {"targets":[{"slotId": X}]}` predicate the SQL
 * uses in listForModel for the subscription branches. Returns true when the
 * manifest declares the slot in its `targets[]` array. Defensive against
 * malformed manifest JSON — never throws.
 */
function manifestTargetsSlot(manifest: unknown, slotId: string): boolean {
  const m = (manifest ?? {}) as { targets?: unknown };
  if (!Array.isArray(m.targets)) return false;
  return m.targets.some((t) => {
    if (!t || typeof t !== 'object') return false;
    const cand = (t as { slotId?: unknown }).slotId;
    return typeof cand === 'string' && cand === slotId;
  });
}

/**
 * W10 — does the manifest declare a full-page surface? A page app carries a
 * `page: { path, title, icon? }` object (validated at registration time). Used
 * to gate the page-mint + SSR resolve so a region/model-only app can't be
 * opened as a full page.
 */
function manifestDeclaresPage(manifest: unknown): boolean {
  const m = (manifest ?? {}) as { page?: unknown };
  if (!m.page || typeof m.page !== 'object') return false;
  const page = m.page as { path?: unknown };
  return typeof page.path === 'string' && page.path.length > 0;
}

/**
 * PAGE-ONLY LAUNCH GATE — the app-level predicate behind the slot-level
 * `isLaunchSlot` allowlist (src/shared/constants/slot-registry.ts).
 *
 * The public (non-mod) marketplace exposes launch slots only. The ONLY launch
 * slot today is `app.page`, and a page app is identified at the app level by
 * declaring its page surface (the `page` field — never a `targets[]` entry; the
 * manifest validator forbids `app.page` in targets). So "this app's slot is a
 * launch slot" ⇔ "this app declares a page". `manifestDeclaresPage` is reused so
 * the launch check and the page-mint / SSR-resolve path agree on what a page is.
 *
 * Gated on `isLaunchSlot(PAGE_SLOT_ID)` so the slot-registry allowlist stays the
 * single source of truth: if `app.page` were ever removed from
 * `LAUNCH_SLOT_IDS`, this returns false for every app and the public surface
 * goes (correctly) empty — no separate edit here.
 */
function isAppLaunchEligible(manifest: unknown): boolean {
  return isLaunchSlot(PAGE_SLOT_ID) && manifestDeclaresPage(manifest);
}

/**
 * The SQL embodiment of {@link isAppLaunchEligible}, applied in the public
 * marketplace queries when the caller is a non-moderator (`launchOnly`).
 *
 * Returns a Prisma.sql predicate that keeps ONLY launch-eligible (page) apps:
 *   - while `app.page` is a launch slot: `manifest->'page'->>'path'` is a
 *     non-empty string (the same "declares a page" test `manifestDeclaresPage`
 *     applies in JS — `->>` yields NULL for a missing/non-string path);
 *   - if `app.page` is no longer a launch slot: `false` (public surface empty),
 *     mirroring `isAppLaunchEligible`.
 *
 * For a moderator caller the router passes `launchOnly=false` → this is omitted
 * entirely (grandfather: mods see/install/mint everything).
 */
function launchOnlySqlFilter(launchOnly: boolean): Prisma.Sql {
  if (!launchOnly) return Prisma.sql`TRUE`;
  if (!isLaunchSlot(PAGE_SLOT_ID)) return Prisma.sql`FALSE`;
  return Prisma.sql`COALESCE(ab.manifest->'page'->>'path', '') <> ''`;
}

/**
 * NSFW-APP-RED-ONLY — the SQL embodiment of the host maturity gate, applied in
 * the public marketplace LISTING queries (listAvailable / getFeaturedBlocks /
 * getAppDetail). A mature-rated app (`content_rating` ∈ {r, x}, the authoritative
 * approve-time column) is EXCLUDED from listings unless the request is on a
 * red-capable host (`isHostForColor(host, 'red')`, computed in the router and
 * passed as `redCapable`).
 *
 *   - redCapable host (civitai.red) → `TRUE` (no maturity filter; mature apps
 *     are visible).
 *   - any other host (civitai.com, …) → keep ONLY rows whose `content_rating`
 *     is NOT mature. NULL / unknown rating is treated as SFW (kept) — the column
 *     is non-null on approve, so this only defends a pre-feature row, and the
 *     direction is fail-closed for MATURE rows (the thing we must hide).
 *
 * This is independent of (and stacks with) the launch-only and approved filters.
 */
function matureHostSqlFilter(redCapable: boolean): Prisma.Sql {
  if (redCapable) return Prisma.sql`TRUE`;
  return Prisma.sql`COALESCE(LOWER(ab.content_rating), '') NOT IN ('r', 'x')`;
}

function resolveRenderMode(
  manifestRenderMode: string | undefined,
  blockRenderMode: string,
  trustTier: string
): 'iframe' | 'inline' {
  // The app_blocks.render_mode column is authoritative — it's set at
  // manifest registration time after the validator has gated trust tier ×
  // render mode. The manifest.renderMode field is informational only
  // (carried into the iframe via BLOCK_INIT for blocks that want to know
  // how they were dispatched). If the two disagree, the column wins.
  //
  // Per spec §2.10: inline only allowed for verified/internal trust tier.
  // Hybrid resolves to inline only when allowed; otherwise falls back to iframe.
  const requested = manifestRenderMode ?? blockRenderMode ?? 'iframe';
  const allowsInline = trustTier === 'verified' || trustTier === 'internal';
  if ((requested === 'inline' || requested === 'hybrid') && allowsInline) return 'inline';
  return 'iframe';
}

/**
 * Block Registry — queries enabled block installs for a (modelId, slotId)
 * combination, applies the emergency kill list, and caches in Redis for 60s.
 *
 * Publisher Opt-Out invariant (plan §4, post kill_per_model_installs):
 *   The NOT EXISTS subquery against pinned `block_user_subscriptions`
 *   (scope='publisher_all_my_models' AND slot_id IS NOT NULL AND target
 *   _model_ids contains modelId) checks ONLY the (model, slot, app_block)
 *   triple — NOT `enabled`. This is what makes `toggleEnabled(false)` on
 *   a pinned subscription an opt-out mechanism (suppresses the blanket
 *   sub + platform default) instead of a no-op.
 */
export class BlockRegistry {
  static async listForModel(opts: ListForModelOpts): Promise<BlockInstallRecord[]> {
    const { modelId, slotId, modelType, modelNsfwLevel } = opts;
    const viewerUserId = opts.viewerUserId ?? null;
    const redCapable = opts.redCapable === true;
    const maxRating = maxRatingForNsfwLevel(modelNsfwLevel);
    const maxRatingIdx = CONTENT_RATING_INDEX[maxRating];
    // NSFW-APP-RED-ONLY: drop a record whose app is mature-rated (r/x) when the
    // request is not on a red-capable host. The record carries `manifest.
    // contentRating` (projected below), so this works identically on a cache hit
    // and on a fresh DB read. Fail-closed: !redCapable hides mature apps.
    const passesHostMaturity = (r: BlockInstallRecord): boolean =>
      redCapable || !isMatureContentRating(r.manifest?.contentRating ?? null);
    // v1: disable the shared (modelId, slotId) cache layer whenever a
    // viewer is attached, since viewer_personal subscriptions make the
    // result per-viewer. The 60s cache for anon viewers and authed
    // viewers who happen to have no viewer_personal subs both pay the
    // DB cost in this branch — that's the tradeoff. Per the handoff,
    // a split cache layer is v2 work.
    const cacheEnabled = viewerUserId == null;
    const key = cacheKey(modelId, slotId);

    if (cacheEnabled) {
      try {
        const cached = await redis.packed.get<BlockInstallRecord[]>(key);
        if (cached) {
          const kill = await getKillList();
          // M-7: sentinel from getKillList() means sysRedis is unreachable;
          // suppress everything on this branch (cached path).
          if (kill.has('__KILL_LIST_UNREACHABLE__')) return [];
          // Apply the host-maturity gate on the cache hit too — the cache key is
          // host-agnostic, so a .red-populated entry must not leak mature apps to
          // a .com reader.
          const live = kill.size === 0 ? cached : cached.filter((r) => !kill.has(r.blockId));
          return live.filter(passesHostMaturity);
        }
      } catch {
        // fail open — fall through to DB
      }
    }

    type Row = {
      block_instance_id: string;
      block_id: string;
      app_id: string;
      app_block_id: string;
      manifest: unknown;
      settings: unknown;
      enabled: boolean;
      render_mode: string;
      trust_tier: string;
      manifest_render_mode: string | null;
    };
    // SQL notes (post kill_per_model_installs absorb):
    //   - Source rank 1 is the per-model-PINNED subscription shape (was
    //     model_block_installs). One row per (user, app, scope, slot,
    //     target_model_ids[1]). block_instance_id is preserved across the
    //     migration (the old bki_* id) so downstream tables (attribution,
    //     scope invocations, user settings) keep resolving.
    //   - Source rank 2 is the BLANKET publisher subscription shape
    //     (target_model_ids=[] AND slot_id IS NULL). We still synthesise
    //     bus_pub_<id> for these since multiple slots may render through
    //     one blanket row and the synthetic id stays stable across slot
    //     reads.
    //   - INVARIANT (see plan §4): the NOT EXISTS clause on rank 2 checks
    //     for a pinned sub on (model, app, slot) regardless of enabled —
    //     so toggleEnabled(false) on a pinned sub continues to opt OUT of
    //     blanket subs + platform defaults.
    //   - Slot manifest match (`@>`) only matters for blanket rows since
    //     pinned rows already carry slot_id directly.
    //   - I15: content-rating filter happens in JS after the row map.
    const slotMatch = `{"targets":[{"slotId":"${slotId}"}]}`;
    const rows = (await dbRead.$queryRaw<Row[]>`
      SELECT * FROM (
        -- Source rank 1: per-model pinned subscriptions (publisher's specific
        -- choice for this model in this slot). The pinned shape — slot_id
        -- NOT NULL AND target_model_ids contains the modelId. enabled=true
        -- only; disabled pinned subs are the publisher opt-out path that
        -- gets handled via NOT EXISTS in rank 2.
        SELECT
          bus.block_instance_id AS block_instance_id,
          ab.block_id,
          ab.app_id,
          ab.id AS app_block_id,
          ab.manifest,
          bus.settings,
          bus.enabled,
          ab.render_mode,
          ab.trust_tier,
          (ab.manifest->>'renderMode') AS manifest_render_mode,
          1 AS source_rank,
          0 AS priority
        FROM block_user_subscriptions bus
        JOIN app_blocks ab ON ab.id = bus.app_block_id
        WHERE bus.scope = 'publisher_all_my_models'
          AND bus.enabled = TRUE
          AND ab.status = 'approved'
          -- DEPLOY-GATE (generic, all app-blocks): don't render an installed
          -- block on a model slot until its slug origin has SUCCESSFULLY deployed
          -- (else the iframe 404s). Set on a successful apply, unchanged on
          -- failure AND while a NEW version rebuilds, so a live app mid-re-deploy
          -- keeps rendering. Off-site apps (external_url) have no iframe to
          -- install on a slot, but the exemption keeps it uniform.
          AND (ab.external_url IS NOT NULL OR ab.current_version_deployed_at IS NOT NULL)
          AND bus.slot_id = ${slotId}
          AND ${modelId} = ANY(bus.target_model_ids)
          AND bus.block_instance_id IS NOT NULL
          -- H2 fix: a pinned row carries its own type/base filters (empty by
          -- default, but the schema allows them). Honour them here so a pin
          -- whose own filters exclude this model neither renders (this rank)
          -- nor suppresses the blanket/default (the matching NOT EXISTS
          -- clauses below apply the identical predicate to the pin row).
          AND (
            array_length(bus.target_model_types, 1) IS NULL
            OR (
              ${modelType ?? null}::text IS NOT NULL
              AND ${modelType ?? null}::text = ANY(bus.target_model_types)
            )
          )
          AND (
            array_length(bus.target_base_models, 1) IS NULL
            OR EXISTS (
              SELECT 1 FROM "ModelVersion" mv
              WHERE mv."modelId" = ${modelId}
                AND mv."baseModel" = ANY(bus.target_base_models)
            )
          )

        UNION ALL

        -- Source rank 2: blanket publisher_all_my_models subscriptions for
        -- the model owner. slot_id IS NULL (applies to every slot the
        -- manifest declares) AND target_model_ids IS EMPTY (applies to
        -- every model the user owns). The JOIN on Model.userId = bus.user
        -- _id makes this dynamic: transferring the model swaps which user's
        -- subscriptions apply automatically.
        --
        -- Suppressed by a pinned subscription on (model, app, slot)
        -- regardless of enabled — the publisher opt-out path.
        SELECT
          'bus_pub_' || bus.id AS block_instance_id,
          ab.block_id,
          ab.app_id,
          ab.id AS app_block_id,
          ab.manifest,
          bus.settings,
          TRUE AS enabled,
          ab.render_mode,
          ab.trust_tier,
          (ab.manifest->>'renderMode') AS manifest_render_mode,
          2 AS source_rank,
          0 AS priority
        FROM block_user_subscriptions bus
        JOIN app_blocks ab ON ab.id = bus.app_block_id
        JOIN "Model" m ON m.id = ${modelId} AND m."userId" = bus.user_id
        WHERE bus.scope = 'publisher_all_my_models'
          AND bus.enabled = TRUE
          AND ab.status = 'approved'
          -- DEPLOY-GATE (generic, all app-blocks): don't render an installed
          -- block on a model slot until its slug origin has SUCCESSFULLY deployed
          -- (else the iframe 404s). Set on a successful apply, unchanged on
          -- failure AND while a NEW version rebuilds, so a live app mid-re-deploy
          -- keeps rendering. Off-site apps (external_url) have no iframe to
          -- install on a slot, but the exemption keeps it uniform.
          AND (ab.external_url IS NOT NULL OR ab.current_version_deployed_at IS NOT NULL)
          AND bus.slot_id IS NULL
          AND cardinality(bus.target_model_ids) = 0
          AND ab.manifest @> ${slotMatch}::jsonb
          AND (
            array_length(bus.target_model_types, 1) IS NULL
            OR (
              ${modelType ?? null}::text IS NOT NULL
              AND ${modelType ?? null}::text = ANY(bus.target_model_types)
            )
          )
          AND (
            array_length(bus.target_base_models, 1) IS NULL
            OR EXISTS (
              SELECT 1 FROM "ModelVersion" mv
              WHERE mv."modelId" = ${modelId}
                AND mv."baseModel" = ANY(bus.target_base_models)
            )
          )
          AND NOT EXISTS (
            -- Pinned subscription (any user, any enabled value) on this
            -- (model, slot, app_block) is the publisher opt-out path.
            -- H2 fix: only a pin that actually APPLIES to this model
            -- (its own type/base filters pass) suppresses — otherwise a
            -- non-applicable pin would blank the slot.
            SELECT 1 FROM block_user_subscriptions pin
            WHERE pin.scope = 'publisher_all_my_models'
              AND pin.slot_id = ${slotId}
              AND pin.app_block_id = ab.id
              AND ${modelId} = ANY(pin.target_model_ids)
              AND (
                array_length(pin.target_model_types, 1) IS NULL
                OR (
                  ${modelType ?? null}::text IS NOT NULL
                  AND ${modelType ?? null}::text = ANY(pin.target_model_types)
                )
              )
              AND (
                array_length(pin.target_base_models, 1) IS NULL
                OR EXISTS (
                  SELECT 1 FROM "ModelVersion" mv2
                  WHERE mv2."modelId" = ${modelId}
                    AND mv2."baseModel" = ANY(pin.target_base_models)
                )
              )
          )

        UNION ALL

        -- Source rank 3: platform defaults (mod-promoted, "every model
        -- gets this block"). Suppressed only by a pinned subscription
        -- for the same (model, slot, app_block) — a blanket publisher
        -- subscription on rank 2 does NOT suppress platform defaults,
        -- since the two usually carry different app_blocks anyway.
        SELECT
          'pdb_' || pdb.app_block_id AS block_instance_id,
          ab.block_id,
          ab.app_id,
          ab.id AS app_block_id,
          ab.manifest,
          '{}'::jsonb AS settings,
          TRUE AS enabled,
          ab.render_mode,
          ab.trust_tier,
          (ab.manifest->>'renderMode') AS manifest_render_mode,
          3 AS source_rank,
          pdb.priority AS priority
        FROM platform_default_blocks pdb
        JOIN app_blocks ab ON ab.id = pdb.app_block_id
        WHERE pdb.slot_id = ${slotId}
          AND pdb.enabled = TRUE
          AND ab.status = 'approved'
          -- DEPLOY-GATE (generic, all app-blocks): don't render an installed
          -- block on a model slot until its slug origin has SUCCESSFULLY deployed
          -- (else the iframe 404s). Set on a successful apply, unchanged on
          -- failure AND while a NEW version rebuilds, so a live app mid-re-deploy
          -- keeps rendering. Off-site apps (external_url) have no iframe to
          -- install on a slot, but the exemption keeps it uniform.
          AND (ab.external_url IS NOT NULL OR ab.current_version_deployed_at IS NOT NULL)
          -- H1 (audit-10): pass NULL when modelType is omitted so the ANY
          -- arm cannot match. The prior coalesce-to-empty-string version
          -- accidentally became an exact-match against the empty string,
          -- which would have leaked any row whose target_model_types
          -- array contained an empty string entry. See block-registry
          -- service header for the full rationale.
          AND (
            pdb.target_model_types IS NULL
            OR array_length(pdb.target_model_types, 1) IS NULL
            OR (
              ${modelType ?? null}::text IS NOT NULL
              AND ${modelType ?? null}::text = ANY(pdb.target_model_types)
            )
          )
          AND NOT EXISTS (
            -- H2 fix: a non-applicable pin (own type/base filters exclude
            -- this model) must not suppress the platform default.
            SELECT 1 FROM block_user_subscriptions pin
            WHERE pin.scope = 'publisher_all_my_models'
              AND pin.slot_id = ${slotId}
              AND pin.app_block_id = pdb.app_block_id
              AND ${modelId} = ANY(pin.target_model_ids)
              AND (
                array_length(pin.target_model_types, 1) IS NULL
                OR (
                  ${modelType ?? null}::text IS NOT NULL
                  AND ${modelType ?? null}::text = ANY(pin.target_model_types)
                )
              )
              AND (
                array_length(pin.target_base_models, 1) IS NULL
                OR EXISTS (
                  SELECT 1 FROM "ModelVersion" mv3
                  WHERE mv3."modelId" = ${modelId}
                    AND mv3."baseModel" = ANY(pin.target_base_models)
                )
              )
          )

        UNION ALL

        -- Source rank 4: viewer_personal subscriptions for the current
        -- viewer. Always blanket in v0 (no per-model pinning UI for the
        -- viewer scope), so we filter to slot_id IS NULL + empty target
        -- _model_ids. Anon viewers (viewerUserId IS NULL) match no rows
        -- because user_id is NOT NULL on the table and -1 isn't a valid
        -- User id. Suppressed by any higher-rank source already showing
        -- this app_block for this slot.
        SELECT
          'bus_view_' || bus.id AS block_instance_id,
          ab.block_id,
          ab.app_id,
          ab.id AS app_block_id,
          ab.manifest,
          bus.settings,
          TRUE AS enabled,
          ab.render_mode,
          ab.trust_tier,
          (ab.manifest->>'renderMode') AS manifest_render_mode,
          4 AS source_rank,
          0 AS priority
        FROM block_user_subscriptions bus
        JOIN app_blocks ab ON ab.id = bus.app_block_id
        WHERE bus.scope = 'viewer_personal'
          AND bus.user_id = ${viewerUserId ?? -1}
          AND bus.enabled = TRUE
          AND ab.status = 'approved'
          -- DEPLOY-GATE (generic, all app-blocks): don't render an installed
          -- block on a model slot until its slug origin has SUCCESSFULLY deployed
          -- (else the iframe 404s). Set on a successful apply, unchanged on
          -- failure AND while a NEW version rebuilds, so a live app mid-re-deploy
          -- keeps rendering. Off-site apps (external_url) have no iframe to
          -- install on a slot, but the exemption keeps it uniform.
          AND (ab.external_url IS NOT NULL OR ab.current_version_deployed_at IS NOT NULL)
          AND bus.slot_id IS NULL
          AND cardinality(bus.target_model_ids) = 0
          AND ab.manifest @> ${slotMatch}::jsonb
          AND (
            array_length(bus.target_model_types, 1) IS NULL
            OR (
              ${modelType ?? null}::text IS NOT NULL
              AND ${modelType ?? null}::text = ANY(bus.target_model_types)
            )
          )
          AND (
            array_length(bus.target_base_models, 1) IS NULL
            OR EXISTS (
              SELECT 1 FROM "ModelVersion" mv
              WHERE mv."modelId" = ${modelId}
                AND mv."baseModel" = ANY(bus.target_base_models)
            )
          )
          -- A pinned publisher subscription on (model, slot, app_block) is
          -- rendering at rank 1; suppress. H2 fix: only when the pin
          -- actually applies (its own type/base filters pass).
          AND NOT EXISTS (
            SELECT 1 FROM block_user_subscriptions pin
            WHERE pin.scope = 'publisher_all_my_models'
              AND pin.slot_id = ${slotId}
              AND pin.app_block_id = ab.id
              AND ${modelId} = ANY(pin.target_model_ids)
              AND (
                array_length(pin.target_model_types, 1) IS NULL
                OR (
                  ${modelType ?? null}::text IS NOT NULL
                  AND ${modelType ?? null}::text = ANY(pin.target_model_types)
                )
              )
              AND (
                array_length(pin.target_base_models, 1) IS NULL
                OR EXISTS (
                  SELECT 1 FROM "ModelVersion" mv4
                  WHERE mv4."modelId" = ${modelId}
                    AND mv4."baseModel" = ANY(pin.target_base_models)
                )
              )
          )
          -- A blanket publisher subscription for the model owner that
          -- targets this same app_block? skip viewer to avoid duplicate.
          AND NOT EXISTS (
            SELECT 1 FROM block_user_subscriptions pub
            JOIN "Model" m2 ON m2.id = ${modelId} AND m2."userId" = pub.user_id
            WHERE pub.scope = 'publisher_all_my_models'
              AND pub.enabled = TRUE
              AND pub.app_block_id = ab.id
              AND pub.slot_id IS NULL
              AND cardinality(pub.target_model_ids) = 0
          )
          -- A platform default (rank 3) for this same app_block + slot?
          -- skip viewer for the same reason.
          AND NOT EXISTS (
            SELECT 1 FROM platform_default_blocks pdb
            WHERE pdb.slot_id = ${slotId}
              AND pdb.app_block_id = ab.id
              AND pdb.enabled = TRUE
          )
      ) combined
      -- M1 (audit-10): add a deterministic tiebreaker. Installs share
      -- priority=0 (hardcoded), so without installed_at Postgres is free
      -- to return them in any order — and the order can change after a
      -- vacuum. Publishers see this as flicker. block_instance_id is
      -- stable + sortable; using it on the installs branch and priority
      -- on the platform-default branch gives us reproducible ordering.
      ORDER BY source_rank ASC, priority ASC, block_instance_id ASC
      LIMIT ${MAX_BLOCKS_PER_SLOT}
    `) as Row[];

    const kill = await getKillList();
    // M-7: kill-list outage → suppress all blocks on this slot for the
    // cache TTL window.
    if (kill.has('__KILL_LIST_UNREACHABLE__')) return [];
    // Inline carry-through type — the post-map needs raw settings to batch
    // the checkpoint lookup, but those never reach the wire (stripped at
    // the final map below).
    type IntermediateRecord = BlockInstallRecord & { _rawSettings: Record<string, unknown> };
    const result: IntermediateRecord[] = rows
      .filter((r: Row) => !kill.has(r.block_id))
      // I15: drop blocks whose manifest.contentRating exceeds the slot's
      // allowed ceiling. An x-rated block must never render on a pg page.
      // Default to most restrictive ('g') if the manifest is missing it.
      .filter((r: Row) => {
        const m = (r.manifest ?? {}) as { contentRating?: unknown };
        const rating =
          typeof m.contentRating === 'string' && m.contentRating in CONTENT_RATING_INDEX
            ? m.contentRating
            : 'g';
        return CONTENT_RATING_INDEX[rating] <= maxRatingIdx;
      })
      .map((r: Row) => {
        // Explicit projection — the manifest JSONB can carry assetBundleUrl,
        // requiredContext, server-internal hints, etc. that we never want
        // returned to anonymous viewers. Echo only the fields the iframe
        // host actually consumes.
        const m = (r.manifest ?? {}) as Record<string, unknown>;
        const iframeRaw = (m.iframe ?? {}) as Record<string, unknown>;
        const manifest: BlockInstallRecord['manifest'] = {
          iframe: iframeRaw.src
            ? {
                src: String(iframeRaw.src),
                minHeight: typeof iframeRaw.minHeight === 'number' ? iframeRaw.minHeight : 200,
                maxHeight:
                  iframeRaw.maxHeight == null
                    ? null
                    : typeof iframeRaw.maxHeight === 'number'
                    ? iframeRaw.maxHeight
                    : null,
                resizable: iframeRaw.resizable === true,
                sandbox:
                  typeof iframeRaw.sandbox === 'string' ? iframeRaw.sandbox : 'allow-scripts',
              }
            : undefined,
          scopes: Array.isArray(m.scopes)
            ? (m.scopes.filter((s) => typeof s === 'string') as string[])
            : undefined,
          contentRating: typeof m.contentRating === 'string' ? m.contentRating : undefined,
          name: typeof m.name === 'string' ? m.name : undefined,
          renderMode:
            m.renderMode === 'iframe' || m.renderMode === 'inline' || m.renderMode === 'hybrid'
              ? m.renderMode
              : undefined,
        };
        // H-3: project publisher settings through the manifest's
        // `publicSettingsKeys` allowlist. Settings is JSONB, no shape
        // guarantee, and listForModel is public — without the allowlist
        // anything a publisher tucks in here leaks to anonymous viewers.
        // Default to empty (fail-closed) when the manifest doesn't declare
        // any public keys; a publisher who wants to expose a key must
        // explicitly list it in their manifest.
        const publicKeys = Array.isArray(m.publicSettingsKeys)
          ? (m.publicSettingsKeys.filter((k) => typeof k === 'string') as string[])
          : [];
        const rawSettings = (r.settings ?? {}) as Record<string, unknown>;
        const publisherSettings: Record<string, unknown> = {};
        for (const k of publicKeys) {
          if (Object.prototype.hasOwnProperty.call(rawSettings, k)) {
            publisherSettings[k] = rawSettings[k];
          }
        }
        // Carry the raw settings forward (separately from publisherSettings
        // which is publicly-projected) so the post-map step below can read
        // `default_checkpoint_version_id` to batch the ModelVersion lookup.
        // The raw settings never make it into the returned record.
        return {
          blockInstanceId: r.block_instance_id,
          blockId: r.block_id,
          appId: r.app_id,
          appBlockId: r.app_block_id,
          manifest,
          publisherSettings,
          enabled: r.enabled,
          renderMode: resolveRenderMode(
            r.manifest_render_mode ?? undefined,
            r.render_mode,
            r.trust_tier
          ),
          trustTier: (r.trust_tier as BlockInstallRecord['trustTier']) ?? 'unverified',
          _rawSettings: rawSettings,
        };
      });

    // Single batched join to populate `defaultCheckpoint`. Collect every
    // numeric default_checkpoint_version_id we see across all install rows,
    // do one IN-query, then hydrate per row. Avoids N+1 lookups across
    // installs even though MAX_BLOCKS_PER_SLOT caps us at 3 today.
    const checkpointIds = result
      .map((r) => {
        const id = (r._rawSettings as { default_checkpoint_version_id?: unknown })
          .default_checkpoint_version_id;
        return typeof id === 'number' ? id : null;
      })
      .filter((x): x is number => x != null);
    const checkpointMap = new Map<
      number,
      {
        versionId: number;
        modelId: number;
        modelName: string;
        versionName: string;
        baseModel: string;
      }
    >();
    if (checkpointIds.length > 0) {
      const rows = await dbRead.modelVersion.findMany({
        where: { id: { in: checkpointIds }, status: 'Published' },
        select: {
          id: true,
          name: true,
          baseModel: true,
          modelId: true,
          model: { select: { name: true, type: true } },
        },
      });
      for (const row of rows) {
        // Defensive: skip rows that don't actually point at a Checkpoint —
        // publisher's stored value is stale (model type changed since
        // install). Drop the field rather than misrepresent it to the iframe.
        if (row.model.type !== 'Checkpoint') continue;
        checkpointMap.set(row.id, {
          versionId: row.id,
          modelId: row.modelId,
          modelName: row.model.name,
          versionName: row.name,
          baseModel: row.baseModel,
        });
      }
    }
    const hydrated: BlockInstallRecord[] = result.map((r) => {
      const rawId = (r._rawSettings as { default_checkpoint_version_id?: unknown })
        .default_checkpoint_version_id;
      const checkpointId = typeof rawId === 'number' ? rawId : null;
      const defaultCheckpoint =
        checkpointId != null ? checkpointMap.get(checkpointId) ?? null : null;
      const { _rawSettings: _unused, ...rest } = r;
      return { ...rest, defaultCheckpoint };
    });

    if (cacheEnabled) {
      try {
        // Cache the HOST-AGNOSTIC set (all ratings) under the host-agnostic key,
        // so a .red and a .com read share one entry. The per-host maturity gate
        // is applied on read (here + on the cache-hit branch above), never baked
        // into the cached value — otherwise a .com-populated entry would hide
        // mature apps from a subsequent .red reader.
        await redis.packed.set(key, hydrated, { EX: CACHE_TTL_SECONDS });
      } catch {
        // fail open
      }
    }

    // NSFW-APP-RED-ONLY: apply the host maturity gate to the returned set.
    return hydrated.filter(passesHostMaturity);
  }

  /**
   * Computes the server-seeded slot reservation for a (modelId, slotId) by
   * running the SAME filter/eligibility path as {@link listForModel} and
   * folding the result through {@link computeSlotReservation}. Used by the
   * model page during SSR so the App Block slot reserves the correct height
   * up-front (kills the 0px → full-height pop / layout shift).
   *
   * Reuses `listForModel` verbatim — so it inherits the 60s Redis cache for
   * anon viewers, the kill-list filter, content-rating gating, and the
   * indexed SQL path. No new query shape, no N+1: the reservation is just a
   * cheap fold over the rows `listForModel` already produces.
   */
  static async getSlotReservation(opts: ListForModelOpts): Promise<SlotReservation> {
    const installs = await BlockRegistry.listForModel(opts);
    return computeSlotReservation(installs);
  }

  /**
   * Resolves a `blockInstanceId` of any kind — real install (`mbi_*`),
   * platform default (`pdb_*`), publisher subscription (`bus_pub_*`), or
   * viewer subscription (`bus_view_*`) — into the install-shape struct that
   * downstream code expects. Returns `null` when the instance doesn't
   * resolve OR when the caller-supplied `(modelId, slotId)` doesn't match
   * what the source row would actually surface on `listForModel`.
   *
   * **Why re-validate against (modelId, slotId, viewerUserId)?**
   *
   * For real `mbi_*` installs the install row carries its own modelId/slotId
   * so the lookup is unambiguous. For synthetic IDs the row is per-user, not
   * per-model — `bus_pub_<bus.id>` represents "this app_block on every model
   * owned by user X." Without re-validation, an authenticated iframe could
   * lie about modelId in its slotContext to mint a token for a model the
   * subscription doesn't actually surface on. The same applies to viewer
   * subscriptions (must match the actual viewer) and platform defaults
   * (must pass the target_model_types filter).
   *
   * The re-validation re-applies the same predicates the listForModel SQL
   * uses for each rank (see lines ~280-484 in this file). Whatever changes
   * to those predicates in future MUST be mirrored here, or the two paths
   * will disagree about whether a block is surfaced — and the resolver is
   * what gates token issuance / settings writes / workflow submission. The
   * tests in block-registry.resolve-instance.test.ts pin most of the cross-
   * row checks.
   *
   * `db` selects between the read replica (cache-light, eventually
   * consistent) and the primary (replication-lag-safe). Use 'write' for
   * any auth-relevant lookup; 'read' is acceptable for display-only paths
   * (e.g. effective-checkpoint resolution).
   */
  /**
   * A6 — pinned-version manifest/scope resolution.
   *
   * When a subscription pins a version (`pinned_version` set), the host MUST
   * use THAT version's manifest + approved-scope set, NOT the live AppBlock
   * row. Before A6, `resolveBlockInstance` always returned the live row, so a
   * v2 approve that added a scope silently took effect on every pinned install
   * on the next render (the C2 escalation). This loads the approved
   * `app_block_publish_requests` row for the pinned version and substitutes its
   * manifest; `approvedScopes` is re-derived as that manifest's declared scopes
   * (the moderator approved exactly the manifest's scopes for that version — see
   * approveRequest, which writes `approvedScopes = manifestScopes`).
   *
   * Fail-safe: when `pinned_version` is set but no approved publish request
   * exists for it (a version withdrawn/rejected after the pin), we FALL BACK to
   * the live row rather than returning an empty scope set — the pin is
   * informational and a missing pinned manifest shouldn't break a working
   * install. The per-user grant gate at mint time is the authoritative scope
   * ceiling regardless.
   */
  static async applyPinnedVersion(
    live: { manifest: Record<string, unknown>; approvedScopes: string[] },
    appBlockId: string,
    pinnedVersion: string | null,
    db: typeof dbRead | typeof dbWrite
  ): Promise<{ manifest: Record<string, unknown>; approvedScopes: string[] }> {
    if (!pinnedVersion) return live;
    const pinned = await db.appBlockPublishRequest.findFirst({
      where: { appBlockId, version: pinnedVersion, status: 'approved' },
      orderBy: { reviewedAt: 'desc' },
      select: { manifest: true },
    });
    if (!pinned) return live;
    const manifest = (pinned.manifest ?? {}) as Record<string, unknown>;
    const scopes = Array.isArray((manifest as { scopes?: unknown }).scopes)
      ? ((manifest as { scopes: unknown[] }).scopes.filter(
          (s): s is string => typeof s === 'string'
        ))
      : [];
    return { manifest, approvedScopes: scopes };
  }

  static async resolveBlockInstance(opts: {
    blockInstanceId: string;
    modelId: number;
    slotId: string;
    viewerUserId: number | null;
    db?: 'read' | 'write';
  }): Promise<ResolvedBlockInstance | null> {
    const { blockInstanceId, modelId, slotId, viewerUserId } = opts;
    const db = opts.db === 'read' ? dbRead : dbWrite;

    // page_<app_block_id> — W10 full-page app, entity=none (FIN-1 re-derive).
    //
    // A page is STATELESS: no install row, no model entity, no per-owner /
    // per-viewer predicate. It is "viewer-global" — any viewer who can load
    // the page can transact inside it, so the only authoritative check is that
    // the cited AppBlock is APPROVED and actually declares a page surface
    // (exactly resolvePageBlock's contract). modelId/slotId/viewerUserId are
    // intentionally ignored for this source. This branch exists so the
    // buzz-attribution validator re-derives a page purchase to a single
    // source (`page` → `viewer_global`) rather than trusting the client
    // `blockScope`; a forged scope on a `page_*` id is corrected, and a
    // `page_*` id for a non-approved / non-page app fails to resolve (→ the
    // validator strips attribution, fail-safe).
    //
    // NOTE: this resolver path is read-only re-derivation for attribution. The
    // TOKEN MINT page path (block-tokens/index.ts) deliberately does NOT route
    // through here — it builds its own `resolved` from resolvePageBlock with
    // the page-specific budget/scope gates. Both call resolvePageBlock, so they
    // agree on which page apps exist.
    if (blockInstanceId.startsWith('page_')) {
      const appBlockId = blockInstanceId.slice('page_'.length);
      if (!appBlockId) return null;
      const page = await BlockRegistry.resolvePageBlock(appBlockId, {
        db: opts.db === 'read' ? 'read' : 'write',
      });
      if (!page) return null;
      return {
        source: 'page',
        // A page has no model entity. 0 is the documented sentinel; the
        // attribution validator omits blockModelId for the `page` source so
        // a 0 never lands on a row.
        modelId: 0,
        slotId,
        enabled: true,
        settings: {},
        installedByUserId: null,
        appBlock: page.appBlock,
      };
    }

    // mbi_* / bki_* — historical per-model install ids. Since the 2026-05-30
    // kill_per_model_installs migration, these resolve via block_user
    // _subscriptions.block_instance_id (the UNIQUE column the migration
    // preserved). Both prefixes refer to the same shape.
    if (blockInstanceId.startsWith('mbi_') || blockInstanceId.startsWith('bki_')) {
      const sub = await db.blockUserSubscription.findUnique({
        where: { blockInstanceId },
        select: {
          userId: true,
          scope: true,
          slotId: true,
          targetModelIds: true,
          targetModelTypes: true,
          targetBaseModels: true,
          enabled: true,
          settings: true,
          installedByUserId: true,
          pinnedVersion: true,
          appBlock: {
            select: {
              id: true,
              blockId: true,
              appId: true,
              status: true,
              manifest: true,
              approvedScopes: true,
              currentVersionDeployedAt: true,
              app: { select: { allowedScopes: true } },
            },
          },
        },
      });
      if (!sub) return null;
      // Per-model-pinned shape is the only thing that gets a bki_*/mbi_*
      // id — anything else is a stale client cache + a bug. Validate the
      // shape defensively.
      if (sub.scope !== 'publisher_all_my_models') return null;
      if (sub.slotId !== slotId) return null;
      if (!Array.isArray(sub.targetModelIds) || !sub.targetModelIds.includes(modelId)) {
        return null;
      }
      if (!sub.enabled) return null;
      if (!sub.appBlock || sub.appBlock.status !== 'approved') return null;
      // Defense-in-depth: still re-validate the model owner against the
      // subscription user. Same posture as the bus_pub_ branch — without
      // it, a pinned subscription that survives a model-ownership transfer
      // could keep emitting tokens for the new owner's model.
      const model = await db.model.findUnique({
        where: { id: modelId },
        select: { userId: true, type: true },
      });
      if (!model) return null;
      if (model.userId !== sub.userId) return null;
      if (sub.targetModelTypes && sub.targetModelTypes.length > 0) {
        if (!sub.targetModelTypes.includes(model.type)) return null;
      }
      if (sub.targetBaseModels && sub.targetBaseModels.length > 0) {
        const mv = await db.modelVersion.findFirst({
          where: { modelId, baseModel: { in: sub.targetBaseModels } },
          select: { id: true },
        });
        if (!mv) return null;
      }
      const pinnedInstall = await BlockRegistry.applyPinnedVersion(
        {
          manifest: (sub.appBlock.manifest ?? {}) as Record<string, unknown>,
          approvedScopes: sub.appBlock.approvedScopes ?? [],
        },
        sub.appBlock.id,
        sub.pinnedVersion ?? null,
        db
      );
      return {
        source: 'install',
        modelId,
        slotId,
        enabled: true,
        settings: (sub.settings ?? {}) as Record<string, unknown>,
        installedByUserId: sub.installedByUserId,
        appBlock: {
          id: sub.appBlock.id,
          blockId: sub.appBlock.blockId,
          appId: sub.appBlock.appId,
          status: sub.appBlock.status,
          manifest: pinnedInstall.manifest,
          approvedScopes: pinnedInstall.approvedScopes,
          app: sub.appBlock.app ? { allowedScopes: sub.appBlock.app.allowedScopes } : null,
          currentVersionDeployedAt: sub.appBlock.currentVersionDeployedAt ?? null,
        },
      };
    }

    // pdb_<app_block_id>
    if (blockInstanceId.startsWith('pdb_')) {
      const appBlockId = blockInstanceId.slice('pdb_'.length);
      if (!appBlockId) return null;
      // The pdb row + app block. Single query via include.
      const pdb = await db.platformDefaultBlock.findUnique({
        where: { appBlockId },
        select: {
          enabled: true,
          slotId: true,
          targetModelTypes: true,
          appBlock: {
            select: {
              id: true,
              blockId: true,
              appId: true,
              status: true,
              manifest: true,
              approvedScopes: true,
              currentVersionDeployedAt: true,
              app: { select: { allowedScopes: true } },
            },
          },
        },
      });
      if (!pdb || !pdb.enabled) return null;
      if (pdb.slotId !== slotId) return null;
      if (!pdb.appBlock || pdb.appBlock.status !== 'approved') return null;
      // target_model_types filter: empty = applies to all; non-empty needs
      // the model's type to be in the array. We don't have modelType in
      // the resolver context (the caller doesn't carry it), so when the
      // filter is non-empty we have to fetch the Model.type. Cheap single-
      // column read.
      if (pdb.targetModelTypes && pdb.targetModelTypes.length > 0) {
        const m = await db.model.findUnique({
          where: { id: modelId },
          select: { type: true },
        });
        if (!m || !pdb.targetModelTypes.includes(m.type)) return null;
      }
      // Suppression: a pinned publisher subscription for this (model, slot,
      // app_block) overrides the platform default at rank 1 in listForModel.
      // If a stale client cache still holds the pdb_ id, the resolver still
      // returns null so the caller doesn't mint a token for a hidden source.
      const suppressor = await db.blockUserSubscription.findFirst({
        where: {
          scope: 'publisher_all_my_models',
          slotId,
          appBlockId,
          targetModelIds: { has: modelId },
        },
        select: { id: true },
      });
      if (suppressor) return null;
      return {
        source: 'platform_default',
        modelId,
        slotId,
        enabled: true,
        settings: {},
        installedByUserId: null,
        appBlock: {
          id: pdb.appBlock.id,
          blockId: pdb.appBlock.blockId,
          appId: pdb.appBlock.appId,
          status: pdb.appBlock.status,
          manifest: (pdb.appBlock.manifest ?? {}) as Record<string, unknown>,
          approvedScopes: pdb.appBlock.approvedScopes ?? [],
          app: pdb.appBlock.app ? { allowedScopes: pdb.appBlock.app.allowedScopes } : null,
          currentVersionDeployedAt: pdb.appBlock.currentVersionDeployedAt ?? null,
        },
      };
    }

    // bus_pub_<bus.id> — publisher_all_my_models BLANKET subscription. The
    // pinned shape gets a bki_*/mbi_* id (handled above) so a bus_pub_*
    // here must be the blanket shape (slot_id IS NULL, target_model_ids
    // empty).
    if (blockInstanceId.startsWith('bus_pub_')) {
      const busId = blockInstanceId.slice('bus_pub_'.length);
      if (!busId) return null;
      const bus = await db.blockUserSubscription.findUnique({
        where: { id: busId },
        select: {
          userId: true,
          scope: true,
          slotId: true,
          targetModelIds: true,
          enabled: true,
          settings: true,
          targetModelTypes: true,
          targetBaseModels: true,
          pinnedVersion: true,
          appBlock: {
            select: {
              id: true,
              blockId: true,
              appId: true,
              status: true,
              manifest: true,
              approvedScopes: true,
              currentVersionDeployedAt: true,
              app: { select: { allowedScopes: true } },
            },
          },
        },
      });
      if (!bus || !bus.enabled) return null;
      if (bus.scope !== 'publisher_all_my_models') return null;
      // Blanket-only via the bus_pub_ prefix. A pinned subscription must
      // come in as bki_*/mbi_* — anything else is a synthetic-id mismatch.
      if (bus.slotId !== null) return null;
      if (Array.isArray(bus.targetModelIds) && bus.targetModelIds.length !== 0) return null;
      if (!bus.appBlock || bus.appBlock.status !== 'approved') return null;
      // Manifest must declare this slot in its targets[] (matches
      // listForModel's `manifest @> {targets:[{slotId}]}`).
      if (!manifestTargetsSlot(bus.appBlock.manifest as unknown, slotId)) return null;
      // The model must genuinely be owned by the subscription user, else
      // an attacker with their own subscription could mint tokens against
      // someone else's model.
      const model = await db.model.findUnique({
        where: { id: modelId },
        select: { userId: true, type: true },
      });
      if (!model) return null;
      if (model.userId !== bus.userId) return null;
      // target_model_types filter
      if (bus.targetModelTypes && bus.targetModelTypes.length > 0) {
        if (!bus.targetModelTypes.includes(model.type)) return null;
      }
      // target_base_models filter — any published version with a matching
      // baseModel satisfies (mirrors the EXISTS in listForModel SQL).
      if (bus.targetBaseModels && bus.targetBaseModels.length > 0) {
        const mv = await db.modelVersion.findFirst({
          where: { modelId, baseModel: { in: bus.targetBaseModels } },
          select: { id: true },
        });
        if (!mv) return null;
      }
      // Suppression: a pinned subscription on (model, slot, app_block) is
      // rank 1 in listForModel; this blanket sub would be suppressed.
      const suppressor = await db.blockUserSubscription.findFirst({
        where: {
          scope: 'publisher_all_my_models',
          slotId,
          appBlockId: bus.appBlock.id,
          targetModelIds: { has: modelId },
        },
        select: { id: true },
      });
      if (suppressor) return null;
      const pinnedPub = await BlockRegistry.applyPinnedVersion(
        {
          manifest: (bus.appBlock.manifest ?? {}) as Record<string, unknown>,
          approvedScopes: bus.appBlock.approvedScopes ?? [],
        },
        bus.appBlock.id,
        bus.pinnedVersion ?? null,
        db
      );
      return {
        source: 'publisher_subscription',
        modelId,
        slotId,
        enabled: true,
        settings: (bus.settings ?? {}) as Record<string, unknown>,
        // The subscription owner IS the publisher for settings-scope
        // purposes — they're the one whose preferences this row encodes.
        installedByUserId: bus.userId,
        appBlock: {
          id: bus.appBlock.id,
          blockId: bus.appBlock.blockId,
          appId: bus.appBlock.appId,
          status: bus.appBlock.status,
          manifest: pinnedPub.manifest,
          approvedScopes: pinnedPub.approvedScopes,
          app: bus.appBlock.app ? { allowedScopes: bus.appBlock.app.allowedScopes } : null,
          currentVersionDeployedAt: bus.appBlock.currentVersionDeployedAt ?? null,
        },
      };
    }

    // bus_view_<bus.id> — viewer_personal subscription
    if (blockInstanceId.startsWith('bus_view_')) {
      // Anon viewers can never own a viewer subscription (user_id NOT NULL,
      // and -1 isn't a valid User id). Fail-fast.
      if (viewerUserId == null) return null;
      const busId = blockInstanceId.slice('bus_view_'.length);
      if (!busId) return null;
      const bus = await db.blockUserSubscription.findUnique({
        where: { id: busId },
        select: {
          userId: true,
          scope: true,
          slotId: true,
          targetModelIds: true,
          enabled: true,
          settings: true,
          targetModelTypes: true,
          targetBaseModels: true,
          pinnedVersion: true,
          appBlock: {
            select: {
              id: true,
              blockId: true,
              appId: true,
              status: true,
              manifest: true,
              approvedScopes: true,
              currentVersionDeployedAt: true,
              app: { select: { allowedScopes: true } },
            },
          },
        },
      });
      if (!bus || !bus.enabled) return null;
      if (bus.scope !== 'viewer_personal') return null;
      // viewer_personal is always blanket in v0.
      if (bus.slotId !== null) return null;
      if (Array.isArray(bus.targetModelIds) && bus.targetModelIds.length !== 0) return null;
      // The viewer making the request MUST be the subscription owner.
      // Without this an attacker could mint tokens that reference another
      // user's viewer subscription.
      if (bus.userId !== viewerUserId) return null;
      if (!bus.appBlock || bus.appBlock.status !== 'approved') return null;
      if (!manifestTargetsSlot(bus.appBlock.manifest as unknown, slotId)) return null;
      const model = await db.model.findUnique({
        where: { id: modelId },
        select: { userId: true, type: true },
      });
      if (!model) return null;
      if (bus.targetModelTypes && bus.targetModelTypes.length > 0) {
        if (!bus.targetModelTypes.includes(model.type)) return null;
      }
      if (bus.targetBaseModels && bus.targetBaseModels.length > 0) {
        const mv = await db.modelVersion.findFirst({
          where: { modelId, baseModel: { in: bus.targetBaseModels } },
          select: { id: true },
        });
        if (!mv) return null;
      }
      // Cascading suppression mirrors the NOT EXISTS clauses on the
      // rank-4 branch in listForModel: pinned-sub (rank 1), blanket
      // publisher-sub for model owner (rank 2), platform default (rank 3).
      const rank1 = await db.blockUserSubscription.findFirst({
        where: {
          scope: 'publisher_all_my_models',
          slotId,
          appBlockId: bus.appBlock.id,
          targetModelIds: { has: modelId },
        },
        select: { id: true },
      });
      if (rank1) return null;
      const rank2 = await db.blockUserSubscription.findFirst({
        where: {
          scope: 'publisher_all_my_models',
          enabled: true,
          appBlockId: bus.appBlock.id,
          userId: model.userId,
          slotId: null,
          targetModelIds: { isEmpty: true },
        },
        select: { id: true },
      });
      if (rank2) return null;
      const rank3 = await db.platformDefaultBlock.findFirst({
        where: { slotId, appBlockId: bus.appBlock.id, enabled: true },
        select: { appBlockId: true },
      });
      if (rank3) return null;
      const pinnedView = await BlockRegistry.applyPinnedVersion(
        {
          manifest: (bus.appBlock.manifest ?? {}) as Record<string, unknown>,
          approvedScopes: bus.appBlock.approvedScopes ?? [],
        },
        bus.appBlock.id,
        bus.pinnedVersion ?? null,
        db
      );
      return {
        source: 'viewer_subscription',
        modelId,
        slotId,
        enabled: true,
        settings: (bus.settings ?? {}) as Record<string, unknown>,
        installedByUserId: bus.userId,
        appBlock: {
          id: bus.appBlock.id,
          blockId: bus.appBlock.blockId,
          appId: bus.appBlock.appId,
          status: bus.appBlock.status,
          manifest: pinnedView.manifest,
          approvedScopes: pinnedView.approvedScopes,
          app: bus.appBlock.app ? { allowedScopes: bus.appBlock.app.allowedScopes } : null,
          currentVersionDeployedAt: bus.appBlock.currentVersionDeployedAt ?? null,
        },
      };
    }

    // Unknown prefix → not a recognised blockInstanceId.
    return null;
  }

  /**
   * W10 — resolve the STATELESS page block for an approved AppBlock id. A
   * full-page app (`app.page` slot, entity=none) has NO install row: it is
   * resolved directly from the approved `AppBlock` (Decision 2 — no migration).
   * The synthetic block-instance id is `page_<appBlockId>`; this returns the
   * page block shape the token mint needs (manifest + approvedScopes + app
   * ceiling), or null when the id is missing / not approved (fail-closed, never
   * leaks a non-approved app's data).
   *
   * `modelId`/`installedByUserId` are intentionally absent for a page —
   * `source: 'platform_default'` is reused only as the closest non-install
   * source label; the page path NEVER stamps a modelId and never grants money
   * scopes (the mint enforces both).
   */
  static async resolvePageBlock(
    appBlockId: string,
    opts?: { db?: 'read' | 'write' }
  ): Promise<PageBlockResolution | null> {
    if (!appBlockId) return null;
    const db = opts?.db === 'read' ? dbRead : dbWrite;
    const ab = await db.appBlock.findUnique({
      where: { id: appBlockId },
      select: {
        id: true,
        blockId: true,
        appId: true,
        status: true,
        manifest: true,
        approvedScopes: true,
        currentVersionDeployedAt: true,
        app: { select: { allowedScopes: true } },
      },
    });
    if (!ab || ab.status !== 'approved') return null;
    const manifest = (ab.manifest ?? {}) as Record<string, unknown>;
    // A page app MUST declare a `page` block in its manifest. Without it the
    // app is a region/model block and has no full-page surface to mint for.
    if (!manifestDeclaresPage(manifest)) return null;
    return {
      appBlock: {
        id: ab.id,
        blockId: ab.blockId,
        appId: ab.appId,
        status: ab.status,
        manifest,
        approvedScopes: ab.approvedScopes ?? [],
        app: ab.app ? { allowedScopes: ab.app.allowedScopes } : null,
        currentVersionDeployedAt: ab.currentVersionDeployedAt ?? null,
      },
    };
  }

  /**
   * W10 — resolve a page block by its `<slug>` (== AppBlock.block_id), for the
   * SSR page route. Returns the approved app's id + manifest iframe.src + page
   * descriptor, or null when no approved page app owns that slug (→ 404).
   * `block_id` is GLOBALLY unique (`@@unique([blockId])`, the W1 C-3 constraint),
   * so the slug → app mapping is guaranteed 1:1.
   */
  static async resolvePageBlockBySlug(
    slug: string,
    opts?: { db?: 'read' | 'write' }
  ): Promise<PageBlockSsr | null> {
    if (!slug) return null;
    const db = opts?.db === 'read' ? dbRead : dbWrite;
    const ab = await db.appBlock.findFirst({
      where: { blockId: slug, status: 'approved' },
      select: {
        id: true,
        blockId: true,
        appId: true,
        manifest: true,
        // #2: the AppBlock.trustTier COLUMN is the authoritative, mod-controlled
        // trust tier. It must drive the iframe sandbox — NOT `manifest.trustTier`,
        // which is a publisher-self-declared field (using it reintroduces the C1
        // trust-tier self-escalation class for the page sandbox). Mirrors the
        // model render path, which reads the `trust_tier` column (see
        // resolveRenderMode + the `r.trust_tier` raw select used by listForModel).
        trustTier: true,
        // NSFW-APP-RED-ONLY: authoritative content rating (set on approve). The
        // SSR run-page gate uses it to 404 a mature page app off a red host.
        contentRating: true,
      },
    });
    if (!ab) return null;
    const manifest = (ab.manifest ?? {}) as Record<string, unknown>;
    if (!manifestDeclaresPage(manifest)) return null;
    const iframe = (manifest.iframe ?? {}) as { src?: unknown };
    const iframeSrc = typeof iframe.src === 'string' ? iframe.src : '';
    // #7: extract the sandbox from `iframe.sandbox` independently — the prior
    // gate on `typeof iframe.src === 'string'` was misleading (sandbox presence
    // has nothing to do with src being a string). Harmless before (src/sandbox
    // are written together) but wrong; gate on the field actually being read.
    const sandbox = typeof iframe === 'object' && iframe !== null
      ? (iframe as { sandbox?: unknown }).sandbox
      : '';
    const page = (manifest.page ?? {}) as { title?: unknown; icon?: unknown };
    const name = typeof manifest.name === 'string' ? manifest.name : ab.blockId;
    // #3/#6: surface the page's declared scopes so the host can compute the
    // ACTUAL granted scope set (declared − missing) for BLOCK_INIT, mirroring
    // IframeHost. Money/spend scopes are rejected at mint for a page, so this is
    // effectively the consent-exempt ambient set (apps:storage:*) once approved.
    const declaredScopes = Array.isArray((manifest as { scopes?: unknown }).scopes)
      ? ((manifest as { scopes: unknown[] }).scopes.filter(
          (s): s is string => typeof s === 'string'
        ))
      : [];
    return {
      appBlockId: ab.id,
      blockId: ab.blockId,
      appId: ab.appId,
      iframeSrc,
      sandbox: typeof sandbox === 'string' ? sandbox : '',
      // #2: use the COLUMN (authoritative), never `manifest.trustTier`.
      trustTier:
        ab.trustTier === 'verified' || ab.trustTier === 'internal'
          ? (ab.trustTier as 'verified' | 'internal')
          : 'unverified',
      name,
      pageTitle: typeof page.title === 'string' ? page.title : name,
      scopes: declaredScopes,
      // NSFW-APP-RED-ONLY: NULL-safe (column is non-null on approve, but defend
      // against a pre-feature / partial row → treated as SFW by the gate).
      contentRating: typeof ab.contentRating === 'string' ? ab.contentRating : null,
    };
  }

  /**
   * APP DEV TUNNEL — resolve the caller's OWN app by `blockId` (== AppBlock
   * `block_id`, GLOBALLY unique via `@@unique([blockId])`) at ANY status, for the
   * `/apps/dev/<blockId>` SSR route + the startDevTunnel gate. Ownership is
   * enforced IN the query (`app.userId === userId`), so a `blockId` owned by a
   * DIFFERENT author — or no such app — returns null (no ownership/existence
   * oracle). Unlike resolvePageBlockBySlug this does NOT require `status:approved`
   * NOR `manifestDeclaresPage`: a developer iterating locally may have a
   * draft/pending app whose manifest has no page block yet. The dev host renders
   * the LOCAL code via the tunnel, so the manifest iframe/page is irrelevant here.
   *
   * NOTE: this returns NO iframeSrc — the route derives the iframe host from the
   * assigned tunnel host ONLY (T6). It cannot be used to serve a deployed bundle.
   *
   * EPHEMERAL PRE-SUBMIT FALLBACK (Phase 1): when the caller owns NO AppBlock row
   * for `blockId` at all (the app has not been submitted/approved — no row + no
   * OauthClient are created until moderator APPROVE), we attempt an EPHEMERAL
   * resolution so an author can iterate on local code in the real host BEFORE
   * submitting. It writes NO DB row and returns a synthetic resolution with safe
   * `unverified` defaults (see resolveEphemeralDevPageBlock). SCOPED features
   * (Buzz / App Storage block-token mint) remain 403 until approval — the prod
   * block-token mint (`/api/v1/block-tokens`) still gates on `status:'approved'`
   * and is untouched here; this is UI / local-code rendering only.
   */
  static async resolveDevPageBlockForAuthor(
    blockId: string,
    userId: number,
    opts?: {
      db?: 'read' | 'write';
      /** BRAND-NEW (no pending row) scope source: the caller's dev-tunnel session's
       *  clamped `grantedScopes` (from their local `block.manifest.json`, sent by the
       *  CLI at tunnel start). Ignored for the pending (own submission → server-read
       *  manifest) and owned-approved paths. Absent → brand-new resolves read-only. */
      sessionGrantedScopes?: string[];
      /** Whether the dedicated `app-blocks-dev-tunnel-unsubmitted-spend` flag is ON
       *  for the caller. When false, the BRAND-NEW branch strips `ai:write:budgeted`
       *  (renders read-only). Fail-closed default (false). No effect on pending. */
      unsubmittedSpendAllowed?: boolean;
    }
  ): Promise<DevPageBlockResolution | null> {
    if (!blockId || !userId) return null;
    const db = opts?.db === 'write' ? dbWrite : dbRead;
    const ab = await db.appBlock.findFirst({
      // Ownership-scoped: the app's OauthClient.userId is the v1 ownership source
      // of truth (same as getMyAppRepo). A foreign-owned or missing app → null,
      // in which case we fall through to the ephemeral pre-submit path below.
      where: { blockId, app: { userId } },
      select: {
        id: true,
        blockId: true,
        appId: true,
        status: true,
        manifest: true,
        trustTier: true,
        contentRating: true,
      },
    });
    // No OWNED AppBlock row → try the ephemeral pre-submit resolution (Phase 1).
    // resolveEphemeralDevPageBlock returns null (→ same bare NOT_FOUND, no oracle)
    // for a slug claimed by anyone else, so a foreign-owned app is never leaked.
    if (!ab)
      return this.resolveEphemeralDevPageBlock(blockId, userId, db, {
        sessionGrantedScopes: opts?.sessionGrantedScopes,
        unsubmittedSpendAllowed: opts?.unsubmittedSpendAllowed,
      });
    const manifest = (ab.manifest ?? {}) as Record<string, unknown>;
    const iframe = (manifest.iframe ?? {}) as { sandbox?: unknown };
    const page = (manifest.page ?? {}) as { title?: unknown };
    const name = typeof manifest.name === 'string' ? manifest.name : ab.blockId;
    const declaredScopes = Array.isArray((manifest as { scopes?: unknown }).scopes)
      ? (manifest as { scopes: unknown[] }).scopes.filter((s): s is string => typeof s === 'string')
      : [];
    return {
      appBlockId: ab.id,
      blockId: ab.blockId,
      appId: ab.appId,
      status: ab.status,
      trustTier:
        ab.trustTier === 'verified' || ab.trustTier === 'internal'
          ? (ab.trustTier as 'verified' | 'internal')
          : 'unverified',
      name,
      pageTitle: typeof page.title === 'string' ? page.title : name,
      sandbox: typeof iframe.sandbox === 'string' ? iframe.sandbox : '',
      scopes: declaredScopes,
      contentRating: typeof ab.contentRating === 'string' ? ab.contentRating : null,
    };
  }

  /**
   * EPHEMERAL PRE-SUBMIT DEV RESOLUTION (Phase 1 — "ephemeral resolution", design
   * approach C). Reached ONLY from resolveDevPageBlockForAuthor when the caller
   * owns NO AppBlock row for `blockId`. Lets an author open a dev tunnel for a
   * BRAND-NEW app they have not yet submitted (before any AppBlock/OauthClient row
   * exists), so they can iterate on local code inside the real host. Writes NO DB
   * row — the returned resolution is a purely synthetic, ownership/existence gate
   * plus manifest DISPLAY defaults; the iframe host is still derived from the live
   * tunnel only (the resolution carries no iframeSrc).
   *
   * SECURITY — ANTI-SHADOW GUARD (refuse any slug claimed by someone else). Every
   * refusal returns the SAME bare null the "foreign / absent app" case returns, so
   * the guard NEVER distinguishes AMONG the claimed cases: foreign-approved,
   * foreign-pending, and foreign-suspended all yield an identical bare null. It is
   * NOT a full "no existence oracle" (see the caller comment in blocks.router.ts):
   * a claimed slug returns null (consuming no host-pool / rate-limit budget) while
   * an unclaimed slug returns a synthetic resolution (which downstream may allocate
   * a rate-limited host), so a claimed-vs-unclaimed signal is inherent. Approved
   * slugs are already PUBLIC (they render at `<slug>.civit.ai`), so the only
   * residual signal this leaks is the EXISTENCE of a pending/suspended slug — and
   * only to another author-flagged (trusted-cohort) caller, gated behind the
   * per-user rate limit. That residual is the accepted trade for the pre-submit UX.
   *   (A) if ANY AppBlock row exists for `blockId` → REFUSE. The caller-owned row
   *       was already checked (and returned) by the caller, so any row reaching
   *       here is FOREIGN. `block_id` is GLOBALLY unique (`@@unique([blockId])`,
   *       `app_blocks_block_id_unique`), so a single indexed lookup settles it: a
   *       row (any status/owner) means the slug is claimed and can never become
   *       the caller's — a superset of "an approved AppBlock exists (any owner)".
   *   (B) if an AppBlockPublishRequest with `status:'pending'` exists for `blockId`
   *       owned by a DIFFERENT user → REFUSE. The partial unique index
   *       `UNIQUE(slug) WHERE status='pending'` guarantees ≤1 pending row per slug,
   *       so this is a single indexed (`app_block_publish_requests_slug_idx`)
   *       lookup. The caller's OWN pending request is ALLOWED (they are claiming
   *       the slug), as is a truly-unclaimed slug.
   *   (C) if `blockId` is not a CANONICAL slug (the same `SLUG_REGEX` + 3–40-char
   *       bounds submit enforces on `manifest.blockId`) → REFUSE, returning the
   *       same bare null BEFORE any DB read. Every stored AppBlock.blockId / pending
   *       slug is canonical, so a non-canonical `blockId` can never match a real row
   *       — without this guard an uppercase / dotted / over-length / leading-digit
   *       string would sail past guards (A)/(B) as "unclaimed" and burn a
   *       rate-limited host-pool allocation. The owned path is unaffected (its rows
   *       are always canonical, so it never reaches here).
   * A user can therefore NEVER get an ephemeral resolution for a slug that belongs
   * to — or is pending for — anyone else, nor for a structurally-invalid slug, and
   * the refusal never reveals WHICH of these cases triggered it.
   *
   * Safe DISPLAY defaults (no DB row, no reviewed manifest): `unverified` trust
   * tier, EMPTY scopes (scoped block-token mint stays 403 until approval — Phase 2),
   * SFW `contentRating`, and a minimal `allow-scripts allow-forms` sandbox that
   * matches the unverified-tier allowed set (the client re-clamps via
   * intersectSandbox, so this can only ever be as wide as the tier permits). The
   * synthetic appBlockId/appId use an `ephemeral-<slug>` namespace that can never
   * collide with a real AppBlock.id or an OauthClient.id (UUIDv4 / `appblk-<slug>`).
   */
  private static async resolveEphemeralDevPageBlock(
    blockId: string,
    userId: number,
    db: typeof dbRead | typeof dbWrite,
    opts?: { sessionGrantedScopes?: string[]; unsubmittedSpendAllowed?: boolean }
  ): Promise<DevPageBlockResolution | null> {
    // Guard (C): reject a non-CANONICAL slug BEFORE any DB read (same bare null,
    // no oracle). Canonical = the exact constraint submit enforces on
    // manifest.blockId (SLUG_REGEX + 3–40 chars). Every stored blockId/pending
    // slug is canonical, so a non-canonical string can never match a real row —
    // rejecting it here stops an uppercase / dotted (`a.b`) / over-length /
    // leading-digit slug from being treated as "unclaimed" and burning a
    // rate-limited host-pool allocation. The owned path never reaches this
    // (its rows are always canonical, so guard-A/B and this are moot for it).
    if (blockId.length < 3 || blockId.length > 40 || !SLUG_REGEX.test(blockId)) {
      return null;
    }
    // Guard (A): any FOREIGN AppBlock row for this slug → refuse (slug is claimed
    // globally via @@unique([blockId])). Indexed on app_blocks_block_id_unique.
    const claimed = await db.appBlock.findUnique({
      where: { blockId },
      select: { id: true },
    });
    if (claimed) return null;
    // Guard (B): a FOREIGN pending publish request for this slug → refuse. ≤1
    // pending row per slug (partial unique index). The caller's own pending is OK.
    const pending = await db.appBlockPublishRequest.findFirst({
      where: { slug: blockId, status: 'pending' },
      select: { submittedByUserId: true, manifest: true },
    });
    if (pending && pending.submittedByUserId !== userId) return null;
    // SCOPE SOURCE — the declared scopes the dev-page host surfaces to the block as
    // `declaredScopes` (→ the block's `granted` UI state) AND the block-token mint
    // uses as the JWT's granted set (both consume the SAME `clampTunnelDeclaredScopes`
    // so they can NEVER diverge). Two ephemeral cases:
    //
    //   • SUBMITTED-PENDING (the caller owns `pending`): clamp the pending
    //     submission's SERVER-READ, un-reviewed `manifest.scopes`. Without this the
    //     block's Generate gate reads empty and hangs on "Grant access" while the JWT
    //     already carries the budgeted scope (the pre-#2992 bug). NOT gated by the
    //     unsubmitted-spend flag — the app IS submitted.
    //   • BRAND-NEW (no pending row, truly-unclaimed slug the caller owns): the scope
    //     source is the AUTHENTICATED CLI's dev-tunnel session (`sessionGrantedScopes`,
    //     already clamped at write) — NEVER a browser body. When the dedicated
    //     `app-blocks-dev-tunnel-unsubmitted-spend` flag is OFF for the caller, strip
    //     `ai:write:budgeted` so a never-reviewed app renders READ-ONLY (fail-closed).
    //
    // NO new authority either way: the belt (TUNNEL allowlist, no OAuth ceiling,
    // keyCanSpend=true) is identical; the runtime author-flag re-check + per-call /
    // per-session / per-day Buzz caps remain the actual spend gates.
    let ephemeralScopes: string[] = [];
    const ephemeralSource: 'pending' | 'brand-new' = pending ? 'pending' : 'brand-new';
    if (pending) {
      const pendingManifest = (pending.manifest ?? {}) as { scopes?: unknown };
      const declared = Array.isArray(pendingManifest.scopes)
        ? pendingManifest.scopes.filter((s): s is string => typeof s === 'string')
        : [];
      ephemeralScopes = clampTunnelDeclaredScopes(declared);
    } else {
      ephemeralScopes = clampTunnelDeclaredScopes(opts?.sessionGrantedScopes ?? []);
      if (!opts?.unsubmittedSpendAllowed) {
        ephemeralScopes = ephemeralScopes.filter((s) => s !== 'ai:write:budgeted');
      }
    }
    // ALLOWED — truly-unclaimed slug, or the caller owns the pending request.
    return {
      // Synthetic, non-resolving ids (`ephemeral-<slug>`): the render path never
      // FK-resolves these (the prod block-token mint 403s on the unapproved app
      // before any appId/appBlockId lookup), and the prefix can never equal a real
      // AppBlock.id nor an OauthClient.id (UUIDv4 / `appblk-<slug>`).
      appBlockId: `ephemeral-${blockId}`,
      blockId,
      appId: `ephemeral-${blockId}`,
      status: 'ephemeral',
      trustTier: 'unverified',
      name: blockId,
      pageTitle: blockId,
      // Minimal safe sandbox for an unverified tier (client intersectSandbox
      // re-clamps to the allowlist ∪ MINIMAL_SANDBOX regardless).
      sandbox: 'allow-scripts allow-forms',
      // Clamped tunnel scopes: the own-pending server-read manifest (pending) or the
      // CLI-declared session scopes (brand-new, flag-gated). Aligned with the
      // block-token mint so the dev-page block's Generate gate is not falsely empty.
      scopes: ephemeralScopes,
      ephemeralSource,
      // SFW default — no reviewed content rating exists pre-submit.
      contentRating: null,
    };
  }

  static async installOnModel(opts: InstallOpts): Promise<{ blockInstanceId: string }> {
    const { modelId, appBlockId, slotId, installedByUserId, settings } = opts;

    // Use dbWrite for the status check to avoid a replication-lag window
    // where a freshly-suspended block could still be installed. Also
    // SELECT manifest + approvedScopes so the W3 generic validator can
    // type-check the submitted settings against what the app declared.
    const block = await dbWrite.appBlock.findUnique({
      where: { id: appBlockId },
      select: {
        status: true,
        blockId: true,
        manifest: true,
        approvedScopes: true,
        version: true,
      },
    });
    // throwNotFoundError/throwBadRequestError throw at runtime, but their
    // signatures return `void`, so TS can't narrow `block` here. Hand-narrow.
    if (!block) throw throwNotFoundError('App block not found') as never;
    if (block.status !== 'approved') {
      throw throwBadRequestError('App block is not approved') as never;
    }

    // Manifest-driven settings validation. Generic settingsSchema (size +
    // JSON) has already run at the router; this layer enforces the per-
    // field shape declared in `manifest.settings` PLUS cross-row checks
    // (checkpoint ecosystem match). Blocks without a `settings` manifest
    // declaration get their input forwarded unchanged.
    const validatedSettings = await validateInstallSettings({
      manifest: (block.manifest ?? {}) as Record<string, unknown>,
      approvedScopes: block.approvedScopes ?? [],
      settings,
      forModelId: modelId,
    });

    // H-4: enforce the per-slot cap at install time. listForModel LIMITs to
    // MAX_BLOCKS_PER_SLOT in SQL, but the prior implementation silently
    // accepted any number of installs. Count pinned subscriptions on
    // (model, slot) regardless of owner; the cap is per-slot global.
    const existingForSlot = await dbWrite.blockUserSubscription.findMany({
      where: {
        scope: 'publisher_all_my_models',
        slotId,
        targetModelIds: { has: modelId },
      },
      select: { appBlockId: true },
    });
    const alreadyInstalled = existingForSlot.some(
      (r: { appBlockId: string }) => r.appBlockId === appBlockId
    );
    if (!alreadyInstalled && existingForSlot.length >= MAX_BLOCKS_PER_SLOT) {
      throwBadRequestError(
        `Slot ${slotId} already has the maximum of ${MAX_BLOCKS_PER_SLOT} installs`
      );
    }

    // Find the existing pinned subscription for this (user, app, scope,
    // slot, model) tuple, if any. Prisma can't express the partial unique
    // index inline, so we use findFirst + create-or-update branch instead
    // of upsert. The DB-level partial UNIQUE index defends against
    // concurrent inserts (a race would manifest as a P2002 — caller can
    // retry).
    //
    // M2: omitting `settings` in the update branch preserves prior values
    // (was the bug that wiped publisher settings on a no-args install).
    const existing = await dbWrite.blockUserSubscription.findFirst({
      where: {
        userId: installedByUserId,
        appBlockId,
        scope: 'publisher_all_my_models',
        slotId,
        targetModelIds: { equals: [modelId] },
      },
      select: { id: true, blockInstanceId: true },
    });

    let resultInstanceId: string;
    if (existing) {
      // Re-enable + (optionally) update settings.
      const updateData: {
        enabled: boolean;
        updatedAt: Date;
        settings?: object;
      } = {
        enabled: true,
        updatedAt: new Date(),
      };
      if (validatedSettings != null) updateData.settings = validatedSettings;
      // Existing rows may have NULL blockInstanceId for legacy reasons;
      // allocate one on first write so downstream tables can resolve.
      let instanceId = existing.blockInstanceId;
      if (!instanceId) {
        instanceId = newBlockInstanceId();
      }
      await dbWrite.blockUserSubscription.update({
        where: { id: existing.id },
        data: { ...updateData, blockInstanceId: instanceId },
      });
      resultInstanceId = instanceId;
    } else {
      const instanceId = newBlockInstanceId();
      await dbWrite.blockUserSubscription.create({
        data: {
          id: newBlockUserSubscriptionId(),
          userId: installedByUserId,
          appBlockId,
          scope: 'publisher_all_my_models',
          slotId,
          targetModelIds: [modelId],
          targetModelTypes: [],
          targetBaseModels: [],
          blockInstanceId: instanceId,
          installedByUserId,
          settings: (validatedSettings ?? {}) as object,
          enabled: true,
        },
      });
      resultInstanceId = instanceId;
    }

    // A6: implicit first-consent. Installing an app on your own model is the
    // act of consent; record the user's grant of the app's currently-approved
    // (consent-gated) scopes against the installed version so the token-mint
    // path can mint them. Additive — a later version that adds a scope leaves
    // this grant in place and the new scope falls into the needs_consent path
    // until the user re-consents. recordScopeGrant has internal failure
    // handling but is awaited so a grant write that fails surfaces (a missing
    // grant would otherwise silently withhold every scope at mint).
    await BlockRegistry.recordInstallConsent({
      userId: installedByUserId,
      appBlockId,
      version: block.version ?? '',
      manifest: (block.manifest ?? {}) as Record<string, unknown>,
      approvedScopes: block.approvedScopes ?? [],
    });

    await invalidateModelCache(modelId);
    return { blockInstanceId: resultInstanceId };
  }

  /**
   * A6 — write the implicit first-consent grant for an install/subscribe. The
   * granted set is the app's approved manifest scopes intersected with what's
   * actually consent-gated (publisher/ambient scopes are exempt — see
   * scope-grant.service). Dynamic import keeps the registry module's load-time
   * graph small + matches the recordScopeInvocation pattern.
   */
  static async recordInstallConsent(opts: {
    userId: number;
    appBlockId: string;
    version: string;
    manifest: Record<string, unknown>;
    approvedScopes: string[];
  }): Promise<void> {
    const { recordScopeGrant, consentGatedScopes } = await import(
      './blocks/scope-grant.service'
    );
    // The app's effective scope set = manifest.scopes ∩ approvedScopes (the
    // moderator-approved snapshot is the ceiling). Grant only the consent-
    // gated subset of that — exempt scopes never need a grant.
    const manifestScopes = Array.isArray((opts.manifest as { scopes?: unknown }).scopes)
      ? ((opts.manifest as { scopes: unknown[] }).scopes.filter(
          (s): s is string => typeof s === 'string'
        ))
      : [];
    const approved = new Set(opts.approvedScopes ?? []);
    const effective = manifestScopes.filter((s) => approved.has(s));
    const toGrant = consentGatedScopes(effective);
    await recordScopeGrant({
      userId: opts.userId,
      appBlockId: opts.appBlockId,
      version: opts.version,
      scopes: toGrant,
    });
  }

  static async uninstallFromModel(opts: UninstallOpts): Promise<void> {
    const { modelId, appBlockId, slotId } = opts;
    // Capture the affected blockInstanceId BEFORE delete so we can write
    // the revocation marker. Otherwise a token issued seconds before
    // uninstall stays valid against the consumer routes until natural exp.
    //
    // Post kill_per_model_installs: the per-model-pinned shape lives on
    // block_user_subscriptions where (scope='publisher_all_my_models',
    // slot_id, target_model_ids contains modelId, app_block_id).
    const rows = (await dbWrite.blockUserSubscription.findMany({
      where: {
        scope: 'publisher_all_my_models',
        slotId,
        appBlockId,
        targetModelIds: { has: modelId },
      },
      select: { id: true, blockInstanceId: true },
    })) as Array<{ id: string; blockInstanceId: string | null }>;
    await dbWrite.blockUserSubscription.deleteMany({
      where: {
        scope: 'publisher_all_my_models',
        slotId,
        appBlockId,
        targetModelIds: { has: modelId },
      },
    });
    for (const { blockInstanceId } of rows) {
      if (blockInstanceId) await BlockRevocation.revokeInstance(blockInstanceId);
    }
    await invalidateModelCache(modelId);
  }

  static async toggleEnabled(opts: ToggleOpts): Promise<void> {
    const { modelId, appBlockId, slotId, enabled } = opts;
    // Post kill_per_model_installs: the per-model-pinned shape lives on
    // block_user_subscriptions. We don't carry userId into this method,
    // but the partial UNIQUE index on (user, app, scope, slot, target
    // _model_ids[1]) guarantees at most one matching row per user — and
    // a global toggle across users for the same (model, slot, app)
    // doesn't have a coherent meaning anyway (the model has one owner).
    const matches = await dbWrite.blockUserSubscription.findMany({
      where: {
        scope: 'publisher_all_my_models',
        slotId,
        appBlockId,
        targetModelIds: { has: modelId },
      },
      select: { id: true, blockInstanceId: true },
    });
    for (const row of matches) {
      await dbWrite.blockUserSubscription.update({
        where: { id: row.id },
        data: { enabled, updatedAt: new Date() },
      });
      if (!row.blockInstanceId) continue;
      // Disable writes a revocation marker; re-enable MUST clear it.
      // Without the clear, every freshly-minted token for this install
      // would be rejected by withBlockScope until the marker's 15-minute
      // TTL elapsed.
      if (enabled) {
        await BlockRevocation.clearInstance(row.blockInstanceId);
      } else {
        await BlockRevocation.revokeInstance(row.blockInstanceId);
      }
    }
    await invalidateModelCache(modelId);
  }

  static async updateSettings(opts: UpdateSettingsOpts): Promise<void> {
    const { blockInstanceId, modelId, settings } = opts;
    // Look up the pinned subscription + its app block (manifest +
    // approvedScopes) so the W3 generic validator can type-check the
    // submitted settings. The blockInstanceId+modelId pair is the auth
    // pin; mismatched → not-found.
    //
    // Post kill_per_model_installs: settings live on
    // block_user_subscriptions. blockInstanceId is unique on that table
    // (partial UNIQUE on non-NULL); we additionally cross-check that the
    // sub's target_model_ids includes the caller-supplied modelId.
    const sub = await dbWrite.blockUserSubscription.findUnique({
      where: { blockInstanceId },
      select: {
        id: true,
        targetModelIds: true,
        appBlock: {
          select: {
            blockId: true,
            manifest: true,
            approvedScopes: true,
          },
        },
      },
    });
    if (!sub || !sub.targetModelIds.includes(modelId)) {
      throwNotFoundError('Block install not found');
    }

    const validatedSettings = await validateInstallSettings({
      manifest: (sub!.appBlock.manifest ?? {}) as Record<string, unknown>,
      approvedScopes: sub!.appBlock.approvedScopes ?? [],
      settings,
      forModelId: modelId,
    });

    // B3: pin modelId in the predicate. updateMany returns count 0 when
    // the install moved to a different model between auth check and write,
    // which we then surface as not-found instead of silently writing to a
    // model the caller no longer owns.
    const result = await dbWrite.blockUserSubscription.updateMany({
      where: {
        blockInstanceId,
        targetModelIds: { has: modelId },
      },
      data: { settings: (validatedSettings ?? {}) as object, updatedAt: new Date() },
    });
    if (result.count === 0) {
      throwNotFoundError('Block install not found');
    }
    await invalidateModelCache(modelId);
  }

  /**
   * Upsert the per-viewer settings row for a (blockInstanceId, userId) pair.
   * Used by `blocks.updateUserSettings` for things like the per-user
   * checkpoint override. Validation (ecosystem match etc.) is the caller's
   * responsibility — the registry method just writes.
   */
  static async upsertUserSettings(opts: {
    blockInstanceId: string;
    userId: number;
    settings: Record<string, unknown>;
  }): Promise<void> {
    const { blockInstanceId, userId, settings } = opts;
    await dbWrite.blockUserSettings.upsert({
      where: { blockInstanceId_userId: { blockInstanceId, userId } },
      create: {
        blockInstanceId,
        userId,
        settings: settings as object,
      },
      update: {
        settings: settings as object,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Read the per-viewer settings row, if any. Returns the raw shape so
   * callers can merge it with publisher defaults as they see fit. Returns
   * null when the viewer has never set anything (including for anon).
   */
  static async getUserSettings(opts: {
    blockInstanceId: string;
    userId: number;
  }): Promise<Record<string, unknown> | null> {
    const row = await dbRead.blockUserSettings.findUnique({
      where: { blockInstanceId_userId: opts },
      select: { settings: true },
    });
    if (!row) return null;
    return (row.settings ?? {}) as Record<string, unknown>;
  }

  /**
   * Compute the effective checkpoint info for a (blockInstanceId, viewer)
   * pair — the merge of publisher default ∪ viewer override resolved into
   * the BlockCheckpointInfo shape the iframe consumes.
   *
   * Used by the IframeHost to populate `BLOCK_INIT.context.checkpoint`
   * BEFORE sending init. Anon viewers (`userId == null`) get the publisher
   * default; authenticated viewers get their override if set.
   *
   * Returns `null` when no checkpoint is configured (rare — install form
   * enforces a publisher default for LoRA installs at write time) AND the
   * bound model isn't itself a Checkpoint.
   */
  static async getEffectiveCheckpoint(opts: {
    blockInstanceId: string;
    /**
     * Auth pin for the resolver. The IframeHost ALWAYS knows (modelId,
     * slotId) for the install it's rendering — it gets both back from
     * listForModel. Forwarding them here lets us re-validate synthetic
     * blockInstanceIds (pdb_*, bus_*) via resolveBlockInstance, which is
     * what unblocks the BLOCK_INIT checkpoint payload for subscription-
     * sourced installs.
     */
    modelId: number;
    slotId: string;
    userId: number | null;
  }): Promise<{
    versionId: number;
    modelId: number;
    modelName: string;
    versionName: string;
    baseModel: string;
  } | null> {
    const { blockInstanceId, modelId, slotId, userId } = opts;

    // Pull the resolved instance (carries publisher settings + source
    // metadata) + the per-viewer settings row (only when authenticated)
    // in parallel.
    const [install, viewerRow, model] = await Promise.all([
      BlockRegistry.resolveBlockInstance({
        blockInstanceId,
        modelId,
        slotId,
        viewerUserId: userId,
        db: 'read',
      }),
      userId != null
        ? dbRead.blockUserSettings.findUnique({
            where: { blockInstanceId_userId: { blockInstanceId, userId } },
            select: { settings: true },
          })
        : Promise.resolve(null),
      dbRead.model.findUnique({
        where: { id: modelId },
        select: { name: true, type: true },
      }),
    ]);
    if (!install || !model) return null;

    // Checkpoint-bound install: the model is its own anchor. Skip the
    // override path entirely — v1 decision keeps Checkpoint installs atomic.
    if (model.type === 'Checkpoint') {
      // We need the version row to fill versionName/baseModel. Pick the
      // most-recent Published version on this model.
      const versionRow = await dbRead.modelVersion.findFirst({
        where: { modelId, status: 'Published' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, baseModel: true },
      });
      if (!versionRow) return null;
      return {
        versionId: versionRow.id,
        modelId,
        modelName: model.name,
        versionName: versionRow.name,
        baseModel: versionRow.baseModel,
      };
    }

    // Compute the candidate checkpoint id via the same precedence chain as
    // resolveBlockCheckpoint, then do a single ModelVersion lookup.
    //
    // W3 v0: settings keys are validated against the app's manifest at
    // write-time. Here we just read the value with a typeof guard — a
    // tighter parse would re-derive the manifest from the install's
    // appBlock for no semantic gain.
    const viewerRaw = (viewerRow?.settings ?? {}) as { checkpoint_version_id?: unknown };
    const overrideId =
      typeof viewerRaw.checkpoint_version_id === 'number'
        ? viewerRaw.checkpoint_version_id
        : undefined;
    const publisherRaw = (install.settings ?? {}) as { default_checkpoint_version_id?: unknown };
    const publisherId =
      typeof publisherRaw.default_checkpoint_version_id === 'number'
        ? publisherRaw.default_checkpoint_version_id
        : undefined;
    const candidate = typeof overrideId === 'number' ? overrideId : publisherId;
    if (typeof candidate === 'number') {
      const row = await dbRead.modelVersion.findUnique({
        where: { id: candidate },
        select: {
          id: true,
          name: true,
          baseModel: true,
          status: true,
          modelId: true,
          model: { select: { name: true, type: true } },
        },
      });
      // Quietly accept the candidate when valid. If it's stale (deleted /
      // unpublished / mistyped) fall through to the platform default below
      // rather than show "missing checkpoint" — the block can still mount
      // with a sensible label.
      if (row && row.status === 'Published' && row.model.type === 'Checkpoint') {
        return {
          versionId: row.id,
          modelId: row.modelId,
          modelName: row.model.name,
          versionName: row.name,
          baseModel: row.baseModel,
        };
      }
    }

    // Platform per-ecosystem fallback. Need the LoRA's baseModel to pick
    // the family — read most-recent Published version on this model. This
    // matches what resolveBlockCheckpoint does at submit time so BLOCK_INIT
    // and submit agree on the same default.
    const loraVersion = await dbRead.modelVersion.findFirst({
      where: { modelId, status: 'Published' },
      orderBy: { createdAt: 'desc' },
      select: { baseModel: true },
    });
    if (loraVersion?.baseModel) {
      const popular = await getPopularCheckpointForEcosystem(loraVersion.baseModel);
      if (popular) {
        return {
          versionId: popular.versionId,
          modelId: popular.modelId,
          modelName: popular.modelName,
          versionName: popular.versionName,
          baseModel: popular.baseModel,
        };
      }
    }
    return null;
  }

  /**
   * Returns every active subscription row for a user (both scopes), with
   * the app_block row denormalised for management-UI rendering. Ordered by
   * most recently updated first so the user sees their latest changes at
   * the top of the list.
   */
  static async listUserSubscriptions(userId: number): Promise<SubscriptionRecord[]> {
    type SubRow = {
      id: string;
      scope: string;
      appBlockId: string;
      targetModelTypes: string[];
      targetBaseModels: string[];
      targetModelIds: number[];
      slotId: string | null;
      pinnedVersion: string | null;
      blockInstanceId: string | null;
      settings: unknown;
      enabled: boolean;
      createdAt: Date;
      updatedAt: Date;
      appBlock: { blockId: string; appId: string; manifest: unknown; version: string | null };
    };
    const rows = (await dbRead.blockUserSubscription.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        scope: true,
        appBlockId: true,
        targetModelTypes: true,
        targetBaseModels: true,
        targetModelIds: true,
        slotId: true,
        pinnedVersion: true,
        blockInstanceId: true,
        settings: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
        appBlock: {
          select: {
            blockId: true,
            appId: true,
            manifest: true,
            version: true,
          },
        },
      },
    })) as SubRow[];

    // Side-table fetch for two purposes:
    //   (a) Render "Pinned to: <Model Name>" badges on the management UI
    //       for pinned subscriptions, without a second per-row round-trip.
    //   (b) List available approved versions per app for the version pin
    //       Select on /apps/installed. Empty array when the app has no
    //       publish_request rows (pre-W1 hackathon apps).
    const pinnedModelIds = new Set<number>();
    for (const row of rows) {
      if (row.targetModelIds) {
        for (const id of row.targetModelIds) pinnedModelIds.add(id);
      }
    }
    const appBlockIds = Array.from(new Set(rows.map((r) => r.appBlockId)));

    const [modelNameRows, versionRows] = await Promise.all([
      pinnedModelIds.size > 0
        ? dbRead.model.findMany({
            where: { id: { in: Array.from(pinnedModelIds) } },
            select: { id: true, name: true },
          })
        : Promise.resolve([] as Array<{ id: number; name: string }>),
      appBlockIds.length > 0
        ? (dbRead.appBlockPublishRequest.groupBy({
            by: ['appBlockId', 'version'],
            where: {
              appBlockId: { in: appBlockIds },
              status: 'approved',
            },
            _max: { reviewedAt: true },
          }) as unknown as Promise<
            Array<{ appBlockId: string | null; version: string; _max: { reviewedAt: Date | null } }>
          >)
        : Promise.resolve(
            [] as Array<{
              appBlockId: string | null;
              version: string;
              _max: { reviewedAt: Date | null };
            }>
          ),
    ]);

    const modelNameById = new Map<number, string>();
    for (const m of modelNameRows) modelNameById.set(m.id, m.name);

    const versionsByApp = new Map<string, { version: string; approvedAt: Date | null }[]>();
    for (const row of versionRows) {
      if (!row.appBlockId) continue;
      const list = versionsByApp.get(row.appBlockId) ?? [];
      list.push({ version: row.version, approvedAt: row._max.reviewedAt });
      versionsByApp.set(row.appBlockId, list);
    }
    for (const list of versionsByApp.values()) {
      list.sort((a, b) => {
        const at = a.approvedAt?.getTime() ?? 0;
        const bt = b.approvedAt?.getTime() ?? 0;
        return bt - at;
      });
    }

    return rows.map((row: SubRow) => {
      const targetIds =
        row.targetModelIds && row.targetModelIds.length > 0 ? row.targetModelIds : null;
      const pinnedModelNames =
        targetIds !== null
          ? Object.fromEntries(
              targetIds.map((id) => [id, modelNameById.get(id) ?? `Model ${id}`])
            )
          : null;
      return {
        id: row.id,
        scope: row.scope as SubscriptionScope,
        appBlockId: row.appBlockId,
        blockId: row.appBlock.blockId,
        appId: row.appBlock.appId,
        // The arrays are NOT NULL in the DB (Prisma drops nullability for
        // String[]). An empty array means "applies to everything"; surface
        // that as `null` for the wire shape so the UI logic stays simple.
        targetModelTypes:
          row.targetModelTypes && row.targetModelTypes.length > 0 ? row.targetModelTypes : null,
        targetBaseModels:
          row.targetBaseModels && row.targetBaseModels.length > 0 ? row.targetBaseModels : null,
        targetModelIds: targetIds,
        pinnedModelNames,
        slotId: row.slotId,
        pinnedVersion: row.pinnedVersion,
        blockInstanceId: row.blockInstanceId,
        currentVersion: row.appBlock.version ?? null,
        availableVersions: versionsByApp.get(row.appBlockId) ?? [],
        settings: (row.settings ?? {}) as Record<string, unknown>,
        enabled: row.enabled,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        manifest: (row.appBlock.manifest ?? {}) as SubscriptionRecord['manifest'],
      };
    });
  }

  /**
   * Idempotent upsert against the (userId, appBlockId, scope) composite
   * unique. Two concurrent toggle clicks land at the same key — Prisma
   * serializes the upsert so neither hits a UNIQUE violation. Settings,
   * targets, enabled all overwrite on update (the caller is the source of
   * truth for the whole row).
   */
  static async upsertSubscription(opts: {
    userId: number;
    appBlockId: string;
    scope: SubscriptionScope;
    targetModelTypes: string[] | null;
    targetBaseModels: string[] | null;
    settings: Record<string, unknown>;
    enabled: boolean;
  }): Promise<SubscriptionRecord> {
    const block = await dbWrite.appBlock.findUnique({
      where: { id: opts.appBlockId },
      select: {
        id: true,
        blockId: true,
        appId: true,
        status: true,
        manifest: true,
        version: true,
        approvedScopes: true,
      },
    });
    if (!block) throw throwNotFoundError('App block not found') as never;
    if (block.status !== 'approved') {
      throw throwBadRequestError('App block is not approved') as never;
    }
    // Empty arrays normalised to an empty TEXT[] in Postgres — the SQL
    // `array_length(... , 1) IS NULL` predicate treats that as "no filter."
    const targetModelTypes = opts.targetModelTypes ?? [];
    const targetBaseModels = opts.targetBaseModels ?? [];

    // upsertSubscription only ever writes the BLANKET shape from the
    // marketplace UI. Per-model pinning goes through installOnModel.
    // The blanket-shape uniqueness is the partial UNIQUE index on
    // (user, app, scope) WHERE slot_id IS NULL AND target_model_ids = [].
    // Prisma can't express partial uniques inline, so we find-then-write.
    const existing = await dbWrite.blockUserSubscription.findFirst({
      where: {
        userId: opts.userId,
        appBlockId: opts.appBlockId,
        scope: opts.scope,
        slotId: null,
        targetModelIds: { isEmpty: true },
      },
      select: { id: true },
    });

    type SubRow = {
      id: string;
      scope: string;
      appBlockId: string;
      targetModelTypes: string[];
      targetBaseModels: string[];
      targetModelIds: number[];
      slotId: string | null;
      pinnedVersion: string | null;
      blockInstanceId: string | null;
      settings: unknown;
      enabled: boolean;
      createdAt: Date;
      updatedAt: Date;
    };
    let row: SubRow;
    if (existing) {
      row = (await dbWrite.blockUserSubscription.update({
        where: { id: existing.id },
        data: {
          targetModelTypes,
          targetBaseModels,
          settings: opts.settings as object,
          enabled: opts.enabled,
          updatedAt: new Date(),
        },
        select: {
          id: true,
          scope: true,
          appBlockId: true,
          targetModelTypes: true,
          targetBaseModels: true,
          targetModelIds: true,
          slotId: true,
          pinnedVersion: true,
          blockInstanceId: true,
          settings: true,
          enabled: true,
          createdAt: true,
          updatedAt: true,
        },
      })) as SubRow;
    } else {
      const candidateId = newBlockUserSubscriptionId();
      row = (await dbWrite.blockUserSubscription.create({
        data: {
          id: candidateId,
          userId: opts.userId,
          appBlockId: opts.appBlockId,
          scope: opts.scope,
          slotId: null,
          targetModelIds: [],
          targetModelTypes,
          targetBaseModels,
          settings: opts.settings as object,
          enabled: opts.enabled,
        },
        select: {
          id: true,
          scope: true,
          appBlockId: true,
          targetModelTypes: true,
          targetBaseModels: true,
          targetModelIds: true,
          slotId: true,
          pinnedVersion: true,
          blockInstanceId: true,
          settings: true,
          enabled: true,
          createdAt: true,
          updatedAt: true,
        },
      })) as SubRow;
    }
    // A6: implicit first-consent. Subscribing an app (blanket publisher- or
    // viewer-scope) is the user's act of consent; record the grant of the
    // app's currently-approved consent-gated scopes against the current
    // version. Additive — a later version that adds a scope leaves this in
    // place and the new scope routes through needs_consent at mint time.
    await BlockRegistry.recordInstallConsent({
      userId: opts.userId,
      appBlockId: opts.appBlockId,
      version: block.version ?? '',
      manifest: (block.manifest ?? {}) as Record<string, unknown>,
      approvedScopes: block.approvedScopes ?? [],
    });

    // Subscription writes can affect what shows up on any model page the
    // user owns (publisher) or visits (viewer). The model-keyed cache
    // can't be safely invalidated by user id alone, so just-write semantics
    // for v1 rely on cache being disabled when viewerUserId != null and on
    // the 60s TTL for the (modelId, slotId) layer. Document for future.
    return {
      id: row.id,
      scope: row.scope as SubscriptionScope,
      appBlockId: row.appBlockId,
      blockId: block.blockId,
      appId: block.appId,
      targetModelTypes:
        row.targetModelTypes && row.targetModelTypes.length > 0 ? row.targetModelTypes : null,
      targetBaseModels:
        row.targetBaseModels && row.targetBaseModels.length > 0 ? row.targetBaseModels : null,
      targetModelIds:
        row.targetModelIds && row.targetModelIds.length > 0 ? row.targetModelIds : null,
      pinnedModelNames: null,
      slotId: row.slotId,
      pinnedVersion: row.pinnedVersion,
      blockInstanceId: row.blockInstanceId,
      currentVersion: block.version ?? null,
      availableVersions: [],
      settings: (row.settings ?? {}) as Record<string, unknown>,
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      manifest: (block.manifest ?? {}) as SubscriptionRecord['manifest'],
    };
  }

  /**
   * Delete a subscription. Owner-only — the userId predicate pins the row
   * so a stolen id can't be deleted by another user. Returns silently when
   * the row doesn't exist (idempotent for retries) but raises authorization
   * when the row exists and belongs to someone else.
   */
  static async deleteSubscription(opts: {
    subscriptionId: string;
    userId: number;
  }): Promise<void> {
    const existing = await dbWrite.blockUserSubscription.findUnique({
      where: { id: opts.subscriptionId },
      select: { userId: true },
    });
    if (!existing) return; // idempotent
    if (existing.userId !== opts.userId) {
      throw throwAuthorizationError('Not the subscription owner') as never;
    }
    await dbWrite.blockUserSubscription.delete({
      where: { id: opts.subscriptionId },
    });
  }

  /**
   * Marketplace listing. Filters by slot (manifest @> {targets:[{slotId}]}),
   * a free-text ILIKE on the manifest name/blockId, and (F-E E3) a mod-assigned
   * `category`. Sortable by `rating` (Bayesian-shrinkage avg rating desc — the
   * DEFAULT; 0-review apps sit mid-pack at the global mean), `popular`
   * (install_count desc), `newest` (current_version_deployed_at desc, falling
   * back to created_at), or `name` (manifest name asc).
   *
   * Cursor: a deterministic keyset over `(sortKey, id)`. We always append
   * `ab.id ASC` as the final tiebreaker so the cursor is unambiguous; the
   * cursor encodes the last row's `id` AND its sort key so a paged scan stays
   * stable even when many rows share a sort value (e.g. install_count=0).
   * At the current scale (<20 approved blocks) any of these is cheap.
   *
   * The `scopesSummary` projection (top N approved scopes) and the `category`
   * field are anon-display-safe (see AvailableBlock); they mirror E2's
   * getAppDetail disclosure. `category` is NULL until the manual E3 migration
   * is applied AND a mod assigns one — the filter is then a no-op (every row
   * null), which is fine while the surface is dark.
   */
  static async listAvailable(
    input: ListAvailableInput,
    // PAGE-ONLY LAUNCH GATE: when true (a non-moderator caller — the router
    // passes `!ctx.user?.isModerator`), the marketplace returns ONLY
    // launch-eligible (page) apps. Defaults false (moderator / internal callers
    // see everything — grandfather). See launchOnlySqlFilter / isLaunchSlot.
    launchOnly = false,
    // NSFW-APP-RED-ONLY: true when the request is on a red-capable host
    // (`isHostForColor(host, 'red')`, computed in the router). When false,
    // mature-rated apps (r/x) are excluded. Defaults false (fail-closed: a
    // caller that forgets to thread the host hides mature apps). Independent of
    // launchOnly — a moderator on civitai.com still does NOT see mature apps in
    // the listing, because maturity is a HOST property, not a privilege.
    redCapable = false
  ): Promise<{ items: AvailableBlock[]; nextCursor?: string }> {
    const { slotId, query, category, sort, cursor, limit } = input;
    type Row = {
      id: string;
      block_id: string;
      app_id: string;
      app_name: string | null;
      manifest: unknown;
      install_count: bigint;
      category: string | null;
      external_url: string | null;
      approved_scopes: string[] | null;
      avg_rating: number | null;
      review_count: bigint;
      // The raw stored screenshots jsonb (the SAME column getAppDetail reads) —
      // projected to a public cover URL below (first screenshot, opaque route).
      screenshots: unknown;
      // The sort key for THIS row, projected so we can encode it into the
      // nextCursor for a stable keyset scan. Text so one column fits all sorts.
      sort_key: string;
    };
    const slotFilter = slotId
      ? `{"targets":[{"slotId":"${slotId}"}]}`
      : null;
    const queryLike = query ? `%${query.toLowerCase()}%` : null;
    const categoryFilter = category ?? null;

    // Keyset cursor = `${sortKey} ${id}` of the last row of the prior page.
    // Split it back into (sortKey, id, mean) so the WHERE clause resumes after
    // it and the `rating` sort reuses the SAME pinned mean across all pages.
    const { cursorSortKey, cursorId, cursorMean } = decodeMarketplaceCursor(cursor);

    // The sort key is a TEXT expression chosen so a plain text comparison
    // orders rows correctly for the requested sort. The SAME expression is used
    // in the SELECT (so the cursor can carry it), the keyset WHERE, and the
    // ORDER BY, defined ONCE here (a Prisma.sql fragment) so they can't drift:
    //   - popular: zero-padded distinct-user install count (DESC text == DESC
    //              numeric; counts are non-negative).
    //   - newest:  COALESCE(deployed_at, created_at) as a sortable UTC string,
    //              DESC (fallback created_at for pre-W2 rows with no deploy ts).
    //   - name:    lower(manifest name OR block_id), ASC.
    // Direction matches the comparison: popular/newest DESC (resume strictly
    // less-than the cursor tuple); name ASC (resume strictly greater-than).
    // ab.id shares the sort_key direction so the row-value tuple comparison is
    // a correct, total keyset.
    // `rating` (the default) needs the marketplace-wide Bayesian prior `m`
    // (cheap, 1h-cached scalar) injected as a param. The other sorts ignore it.
    // PIN `m` across a paging session: page 1 reads the 1h cache and encodes the
    // value it used into nextCursor; pages 2..N decode that pinned `m` and reuse
    // it (NOT a fresh cache read) so the sort key stays identical even if the
    // cache expires/busts mid-pagination — otherwise the keyset boundary shifts
    // and one row is silently skipped or duplicated. Cursorless first page only
    // reads the cache. Other sorts don't use `m` (kept 0).
    const globalMean =
      sort === 'rating'
        ? cursorMean ?? (await getGlobalMeanRating())
        : 0;
    const sortKeyExpr =
      sort === 'rating'
        ? bayesianRatingSortKey(globalMean)
        : sort === 'popular'
        ? Prisma.sql`lpad((SELECT COUNT(DISTINCT bus.user_id) FROM block_user_subscriptions bus WHERE bus.app_block_id = ab.id)::text, 20, '0')`
        : sort === 'newest'
        ? Prisma.sql`to_char(COALESCE(ab.current_version_deployed_at, ab.created_at) AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS')`
        : Prisma.sql`LOWER(COALESCE(ab.manifest->>'name', ab.block_id))`;
    const descending = sort === 'rating' || sort === 'popular' || sort === 'newest';
    const dir = descending ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    const keysetCmp = descending ? Prisma.sql`<` : Prisma.sql`>`;

    const rows = (await dbRead.$queryRaw<Row[]>(Prisma.sql`
      SELECT
        ab.id,
        ab.block_id,
        ab.app_id,
        oc.name AS app_name,
        ab.manifest,
        ab.category,
        ab.external_url,
        ab.approved_scopes,
        ab.screenshots,
        -- Post kill_per_model_installs: "install count" = how many distinct
        -- USERS use this app, not how many subscription rows exist. A single
        -- user can hold several rows for one app (a blanket publisher sub +
        -- a blanket viewer sub + N pinned-to-specific-model subs); counting
        -- rows let a pin-happy publisher inflate their own app's marketplace
        -- ranking. COUNT(DISTINCT user_id) makes the number mean "users".
        (SELECT COUNT(DISTINCT bus.user_id)::bigint FROM block_user_subscriptions bus
         WHERE bus.app_block_id = ab.id) AS install_count,
        -- Marketplace reviews: aggregate-eligible AVG + COUNT (excludes
        -- mod-excluded + self-reviews). NULL avg = 0-review app.
        ${AVG_RATING_SUBQUERY} AS avg_rating,
        ${REVIEW_COUNT_SUBQUERY} AS review_count,
        -- The sort key for this row, as text, so the keyset cursor can carry it.
        ${sortKeyExpr} AS sort_key
      FROM app_blocks ab
      LEFT JOIN "OauthClient" oc ON oc.id = ab.app_id
      WHERE ab.status = 'approved'
        -- DEPLOY-GATE (generic, all app-blocks): only list an ON-PLATFORM app
        -- once it has SUCCESSFULLY deployed its slug origin at least once.
        -- current_version_deployed_at is set on a successful apply and left
        -- unchanged on build failure/timeout AND while a NEW version rebuilds, so
        -- NULL means never-served (hide) and non-null means live (show, incl.
        -- mid-re-deploy). OFF-SITE (external-link) apps host no origin and never
        -- deploy, so external_url presence exempts them (they use externalUrl).
        AND (ab.external_url IS NOT NULL OR ab.current_version_deployed_at IS NOT NULL)
        -- PAGE-ONLY LAUNCH GATE: non-mod callers see launch (page) apps only.
        AND ${launchOnlySqlFilter(launchOnly)}
        -- NSFW-APP-RED-ONLY: hide mature (r/x) apps on non-red hosts.
        AND ${matureHostSqlFilter(redCapable)}
        AND (
          ${slotFilter}::text IS NULL
          OR ab.manifest @> ${slotFilter}::jsonb
        )
        AND (
          ${queryLike}::text IS NULL
          OR LOWER(COALESCE(ab.manifest->>'name', '')) LIKE ${queryLike}
          OR LOWER(ab.block_id) LIKE ${queryLike}
        )
        AND (${categoryFilter}::text IS NULL OR ab.category = ${categoryFilter}::text)
        -- Keyset pagination over (sort_key, id). NULL cursor = first page.
        AND (
          ${cursorSortKey}::text IS NULL
          OR (${sortKeyExpr}, ab.id) ${keysetCmp} (${cursorSortKey}::text, ${cursorId}::text)
        )
      ORDER BY sort_key ${dir}, ab.id ${dir}
      LIMIT ${limit + 1}
    `)) as Row[];
    const trimmed = rows.slice(0, limit);
    const last = trimmed[trimmed.length - 1];
    // Pin `m` into the cursor for the `rating` sort so every subsequent page
    // reuses page 1's mean (see globalMean above). Omitted for other sorts.
    const pinnedMean = sort === 'rating' ? globalMean : undefined;
    const nextCursor =
      rows.length > limit && last
        ? encodeMarketplaceCursor(last.sort_key, last.id, pinnedMean)
        : undefined;
    return {
      // F-E E1 anon-exposure allowlist: project the raw stored manifest down to
      // the vetted PUBLIC subset (name/description/targets[].slotId) via
      // toPublicBlockManifest. The raw manifest is arbitrary publisher JSON plus
      // server-set internal fields (trustTier, internal iframe.src host) — never
      // ship it wholesale to an anon caller. Combined with the WHERE
      // status='approved' filter above, an anon caller can only ever see
      // approved apps + display-safe fields.
      items: trimmed.map((r: Row) => ({
        id: r.id,
        blockId: r.block_id,
        appId: r.app_id,
        appName: r.app_name ?? null,
        manifest: toPublicBlockManifest(r.manifest),
        installCount: Number(r.install_count),
        // Public, mod-assigned category (NULL until the E3 migration + a mod set
        // it). Display-only.
        category: r.category ?? null,
        // Off-site (external-link) app: the off-platform URL the card opens in a
        // new tab. NULL = a normal on-platform app. Validated https:// at
        // registration; display/navigation-only (no token/scope attached).
        externalUrl: r.external_url ?? null,
        // F-E E3 scopes-on-cards: the FIRST N APPROVED scope ids (the same
        // permission-disclosure list E2 surfaces). Defensive against a NULL
        // column (pre-approval rows) → empty list. NEVER the manifest's raw
        // scope declaration.
        scopesSummary: Array.isArray(r.approved_scopes)
          ? r.approved_scopes
              .filter((s): s is string => typeof s === 'string')
              .slice(0, MARKETPLACE_SCOPES_SUMMARY_LIMIT)
          : [],
        // Marketplace reviews (aggregate-eligible). avgRating NULL = 0-review.
        avgRating: r.avg_rating ?? null,
        reviewCount: Number(r.review_count),
        // Card cover: the FIRST public screenshot URL (or NULL when the app
        // shipped none). Reuses the SAME toPublicScreenshots projection the
        // detail page uses — opaque gated route, never the raw MinIO key.
        coverUrl: toPublicScreenshots(r.id, r.screenshots)[0]?.url ?? null,
      })),
      nextCursor,
    };
  }

  /**
   * Per-app marketplace detail (F-E E2). Anon-CAPABLE, but the router gates it
   * behind the mod-segmented appBlocks flag (dark today).
   *
   * 🔒 ANON-EXPOSURE — returns ONLY the PublicAppDetail allowlist for a single
   * `status='approved'` app:
   *   - `manifest` is projected through `toPublicBlockManifest` (name/description
   *     /targets[].slotId only) — the raw stored manifest (trustTier, internal
   *     iframe.src, renderMode, settings internals, raw scopes) is NEVER shipped.
   *   - `scopes` are the APPROVED scope ids (`approved_scopes` column) — the
   *     permission disclosure list, safe to show.
   *   - `liveUrl` is the already-public standalone block origin, built here from
   *     `blockId` + `env.APPS_DOMAIN` (the SAME host the webhook validates the
   *     bundle's iframe against), so the client never needs the domain. No
   *     token / scope is attached.
   *
   * Returns `null` for a missing OR non-approved (pending/rejected/withdrawn)
   * app — the router maps that to NOT_FOUND so a non-approved app's data can
   * never be enumerated by id.
   */
  static async getAppDetail(
    appBlockId: string,
    // PAGE-ONLY LAUNCH GATE: when true (non-mod caller), a non-launch (model)
    // app resolves to null — the router maps that to the SAME NOT_FOUND a
    // missing/unapproved app produces, so a non-mod can't enumerate or read a
    // model-slot app's detail. Defaults false (mods see everything).
    launchOnly = false,
    // NSFW-APP-RED-ONLY: true when the request is on a red-capable host. When
    // false, a mature (r/x) app resolves to null → the router surfaces the SAME
    // NOT_FOUND as a missing app, so a mature app's DETAIL can't be read off
    // .red (mirrors the run-page SSR 404). Defaults false (fail-closed).
    redCapable = false
  ): Promise<PublicAppDetail | null> {
    type Row = {
      id: string;
      block_id: string;
      app_id: string;
      app_name: string | null;
      manifest: unknown;
      status: string;
      content_rating: string | null;
      version: string | null;
      approved_scopes: string[] | null;
      external_url: string | null;
      current_version_deployed_at: Date | null;
      install_count: bigint;
      avg_rating: number | null;
      review_count: bigint;
      // F-E E5: stored screenshot records ([{ key, index, ext, contentType }]),
      // jsonb. NULL until the E5 migration is applied + an app is (re)approved
      // with a `screenshots/` dir — projected to PUBLIC display URLs below.
      screenshots: unknown;
    };
    const rows = (await dbRead.$queryRaw<Row[]>`
      SELECT
        ab.id,
        ab.block_id,
        ab.app_id,
        oc.name AS app_name,
        ab.manifest,
        ab.status,
        ab.content_rating,
        ab.version,
        ab.approved_scopes,
        ab.external_url,
        ab.current_version_deployed_at,
        ab.screenshots,
        (SELECT COUNT(DISTINCT bus.user_id)::bigint FROM block_user_subscriptions bus
         WHERE bus.app_block_id = ab.id) AS install_count,
        ${AVG_RATING_SUBQUERY} AS avg_rating,
        ${REVIEW_COUNT_SUBQUERY} AS review_count
      FROM app_blocks ab
      LEFT JOIN "OauthClient" oc ON oc.id = ab.app_id
      WHERE ab.id = ${appBlockId}::text
      LIMIT 1
    `) as Row[];
    const row = rows[0];
    // Status check is in the application layer (not the WHERE clause) ONLY so a
    // future caller can't accidentally reuse this method for a non-public path;
    // a non-approved row returns null exactly like a missing one — never its
    // data. (The marketplace install mutations apply the same approved gate.)
    if (!row || row.status !== 'approved') return null;
    // PAGE-ONLY LAUNCH GATE (non-mod): a non-launch (model-slot) app is
    // indistinguishable from a missing one to the public — return null so the
    // router surfaces NOT_FOUND (no detail leak). isAppLaunchEligible reuses the
    // same "declares a page" predicate as the listing filter + the page mint.
    if (launchOnly && !isAppLaunchEligible(row.manifest)) return null;
    // DEPLOY-GATE (generic, all app-blocks): an ON-PLATFORM app that has NEVER
    // successfully deployed its `<slug>.<APPS_DOMAIN>` origin is indistinguishable
    // from a missing one — its detail's liveUrl would 404 and it isn't runnable.
    // `current_version_deployed_at` is NULL until the first successful apply and
    // stays set while a NEW version rebuilds (so a live app mid-re-deploy still
    // resolves). OFF-SITE (external-link) apps host no origin and never deploy —
    // `external_url` presence exempts them.
    if (row.external_url == null && row.current_version_deployed_at == null) return null;
    // NSFW-APP-RED-ONLY (non-red host): a mature (r/x) app is indistinguishable
    // from a missing one off .red — return null → NOT_FOUND. Uses the
    // authoritative content_rating column (set on approve), not the manifest.
    if (!redCapable && isMatureContentRating(row.content_rating)) return null;
    return {
      id: row.id,
      blockId: row.block_id,
      appId: row.app_id,
      appName: row.app_name ?? null,
      // PUBLIC allowlist projection — identical to the listing path so the two
      // can't drift in what they expose.
      manifest: toPublicBlockManifest(row.manifest),
      // Approved scope ids only — the permission disclosure list. Defensive
      // against a NULL column (pre-approval rows) → empty list.
      scopes: Array.isArray(row.approved_scopes)
        ? row.approved_scopes.filter((s): s is string => typeof s === 'string')
        : [],
      contentRating: row.content_rating ?? null,
      version: row.version ?? null,
      installCount: Number(row.install_count),
      // Marketplace reviews (aggregate-eligible — excludes mod-excluded +
      // self-reviews). avgRating NULL = 0-review. Display-safe aggregates.
      avgRating: row.avg_rating ?? null,
      reviewCount: Number(row.review_count),
      // Already-public standalone origin (no token/scope). Same host the webhook
      // validates the submitted bundle's iframe.src against. For an external
      // (off-site) app this origin doesn't host anything — the client uses
      // `externalUrl` as the open target instead (and hides install/preview).
      liveUrl: `https://${row.block_id}.${env.APPS_DOMAIN}`,
      // Off-site (external-link) app: the off-platform URL. NULL = on-platform.
      // Validated https:// at registration; display/navigation-only.
      externalUrl: row.external_url ?? null,
      // F-E E5 screenshot gallery — PUBLIC display URLs only (the gated app
      // route), built server-side from appBlockId + index + ext. The stored
      // MinIO key is never exposed; a NULL column (pre-migration / no screenshots)
      // yields []. These images were magic-byte-validated + mod-reviewed.
      screenshots: toPublicScreenshots(row.id, row.screenshots),
    };
  }

  /**
   * F-E E4 featured rail. Anon-CAPABLE (same exposure posture as listAvailable),
   * gated behind the mod-segmented appBlocks flag in the router (dark today).
   *
   * 🔒 ANON-EXPOSURE — returns the SAME public `AvailableBlock` allowlist the
   * marketplace listing uses (id/blockId/appId/appName + the `toPublicBlock
   * manifest` subset + installCount + category + scopesSummary). It is NOT a
   * wider projection — it reuses the exact listing shape so the two can't drift.
   * The WHERE clause additionally hard-filters `featured = true` (on top of
   * `status='approved'`), so ONLY curated, approved apps are returned — a
   * pending/rejected/unfeatured app can never reach an anon caller here.
   *
   * Ordering: `featured_order` ASC with NULLS LAST (a curated, mod-assigned
   * position; unset rows sink to the end), then install_count DESC as a stable
   * tiebreak, then `ab.id` ASC so the order is fully deterministic.
   *
   * No cursor: the featured set is a small curated list (rail above the grid),
   * capped by `limit` (≤24); paginating a staff-pick rail isn't a requirement.
   */
  static async getFeaturedBlocks(
    limit: number,
    // PAGE-ONLY LAUNCH GATE: non-mod callers get launch (page) apps only;
    // mods see every featured app. Defaults false. See launchOnlySqlFilter.
    launchOnly = false,
    // NSFW-APP-RED-ONLY: hide mature (r/x) apps from the featured rail unless on
    // a red-capable host. Defaults false (fail-closed). See matureHostSqlFilter.
    redCapable = false
  ): Promise<AvailableBlock[]> {
    type Row = {
      id: string;
      block_id: string;
      app_id: string;
      app_name: string | null;
      manifest: unknown;
      install_count: bigint;
      category: string | null;
      external_url: string | null;
      approved_scopes: string[] | null;
      avg_rating: number | null;
      review_count: bigint;
      // Raw screenshots jsonb — projected to a public cover URL below (same as
      // listAvailable / getAppDetail).
      screenshots: unknown;
    };
    const rows = (await dbRead.$queryRaw<Row[]>`
      SELECT
        ab.id,
        ab.block_id,
        ab.app_id,
        oc.name AS app_name,
        ab.manifest,
        ab.category,
        ab.external_url,
        ab.approved_scopes,
        ab.screenshots,
        (SELECT COUNT(DISTINCT bus.user_id)::bigint FROM block_user_subscriptions bus
         WHERE bus.app_block_id = ab.id) AS install_count,
        ${AVG_RATING_SUBQUERY} AS avg_rating,
        ${REVIEW_COUNT_SUBQUERY} AS review_count
      FROM app_blocks ab
      LEFT JOIN "OauthClient" oc ON oc.id = ab.app_id
      WHERE ab.status = 'approved'
        -- DEPLOY-GATE (generic, all app-blocks): only list an ON-PLATFORM app
        -- once it has SUCCESSFULLY deployed its slug origin at least once.
        -- current_version_deployed_at is set on a successful apply and left
        -- unchanged on build failure/timeout AND while a NEW version rebuilds, so
        -- NULL means never-served (hide) and non-null means live (show, incl.
        -- mid-re-deploy). OFF-SITE (external-link) apps host no origin and never
        -- deploy, so external_url presence exempts them (they use externalUrl).
        AND (ab.external_url IS NOT NULL OR ab.current_version_deployed_at IS NOT NULL)
        -- PAGE-ONLY LAUNCH GATE: non-mod callers see launch (page) apps only.
        AND ${launchOnlySqlFilter(launchOnly)}
        -- NSFW-APP-RED-ONLY: hide mature (r/x) apps on non-red hosts.
        AND ${matureHostSqlFilter(redCapable)}
        AND ab.featured = true
      ORDER BY ab.featured_order ASC NULLS LAST,
               install_count DESC,
               ab.id ASC
      LIMIT ${limit}
    ` ) as Row[];
    // Project to the SAME public allowlist as listAvailable (no widening).
    return rows.map((r) => ({
      id: r.id,
      blockId: r.block_id,
      appId: r.app_id,
      appName: r.app_name ?? null,
      manifest: toPublicBlockManifest(r.manifest),
      installCount: Number(r.install_count),
      category: r.category ?? null,
      externalUrl: r.external_url ?? null,
      scopesSummary: Array.isArray(r.approved_scopes)
        ? r.approved_scopes
            .filter((s): s is string => typeof s === 'string')
            .slice(0, MARKETPLACE_SCOPES_SUMMARY_LIMIT)
        : [],
      avgRating: r.avg_rating ?? null,
      reviewCount: Number(r.review_count),
      // Card cover: FIRST public screenshot URL (or NULL). Same projection as
      // listAvailable — no widening.
      coverUrl: toPublicScreenshots(r.id, r.screenshots)[0]?.url ?? null,
    }));
  }

  /**
   * F-E E4 — MOD-ONLY: read the current marketplace metadata for one app_block,
   * to seed the review-page curation form. The router gates this with
   * `moderatorProcedure`; this method does NO auth itself.
   *
   * Returns `null` for a missing app (router → NOT_FOUND). Carries `status`
   * (mod-relevant: featuring is approved-only) — this is a moderator surface,
   * not the anon allowlist, so a status field is intentional here.
   */
  static async getMarketplaceMeta(appBlockId: string): Promise<MarketplaceMeta | null> {
    const row = await dbRead.appBlock.findUnique({
      where: { id: appBlockId },
      select: {
        id: true,
        status: true,
        category: true,
        featured: true,
        featuredOrder: true,
      },
    });
    if (!row) return null;
    return {
      appBlockId: row.id,
      status: row.status,
      category: row.category ?? null,
      featured: row.featured,
      featuredOrder: row.featuredOrder ?? null,
    };
  }

  /**
   * F-E E4 — MOD-ONLY: set the platform-controlled marketplace metadata
   * (category / featured / featured_order) on ONE app_block. The router gates
   * this with `moderatorProcedure` + the isModerator belt; this method does NO
   * auth itself (caller must be a moderator).
   *
   * Validation:
   *   - `category` (when provided & non-null) MUST be in the taxonomy const
   *     (`MARKETPLACE_CATEGORIES`). Defense-in-depth: the router schema already
   *     enums it, but a future internal caller can't slip an off-taxonomy value
   *     past this layer. `null` clears it; `undefined` leaves it unchanged.
   *   - Featuring (`featured === true`) is allowed ONLY for a `status='approved'`
   *     app — a pending/rejected/withdrawn/disabled app can never be featured
   *     (it would otherwise surface in the anon featured rail). Un-featuring or
   *     editing category/order on a non-approved app is allowed.
   *   - `featuredOrder` is an int (router-bounded) or null (clear).
   *
   * Returns the updated MarketplaceMeta. Throws NOT_FOUND for a missing app and
   * BAD_REQUEST for an off-taxonomy category or featuring a non-approved app.
   */
  static async setMarketplaceMeta(
    input: SetMarketplaceMetaInput
  ): Promise<MarketplaceMeta> {
    const { appBlockId, category, featured, featuredOrder } = input;

    // Taxonomy belt (router already enums it; re-assert so no off-taxonomy value
    // can ever be written by any caller).
    if (
      category != null &&
      !(MARKETPLACE_CATEGORIES as readonly string[]).includes(category)
    ) {
      throwBadRequestError(`Unknown marketplace category: ${category}`);
    }

    const existing = await dbWrite.appBlock.findUnique({
      where: { id: appBlockId },
      select: { id: true, status: true },
    });
    if (!existing) throwNotFoundError('App block not found');

    // Approved-only featuring: refuse to feature anything not approved (it would
    // otherwise appear in the anon-capable featured rail).
    if (featured === true && existing!.status !== 'approved') {
      throwBadRequestError(
        `Only an approved app can be featured (status="${existing!.status}").`
      );
    }

    // Build the patch from ONLY the provided fields — an omitted (undefined)
    // field is left unchanged; an explicit null clears the column.
    const data: {
      category?: string | null;
      featured?: boolean;
      featuredOrder?: number | null;
    } = {};
    if (category !== undefined) data.category = category;
    if (featured !== undefined) data.featured = featured;
    if (featuredOrder !== undefined) data.featuredOrder = featuredOrder;

    const updated = await dbWrite.appBlock.update({
      where: { id: appBlockId },
      data,
      select: {
        id: true,
        status: true,
        category: true,
        featured: true,
        featuredOrder: true,
      },
    });
    return {
      appBlockId: updated.id,
      status: updated.status,
      category: updated.category ?? null,
      featured: updated.featured,
      featuredOrder: updated.featuredOrder ?? null,
    };
  }
}

/**
 * W3 v0: manifest-driven settings validation. The app's `manifest.settings`
 * declaration (validated against `manifestSettingsSchema` at submission
 * time) is the contract; this function enforces it on every write. Generic
 * JSON-shape + size validation happens in the router; this layer adds
 * per-field type/range checks AND cross-row checks the static manifest
 * can't express (e.g. "the picked checkpoint must exist + share the LoRA's
 * ecosystem").
 *
 * Returns the validated settings object (or `undefined` if the caller passed
 * `undefined`). Throws TRPCError on validation failure — propagates to the
 * router, which surfaces it as a structured error the install-form UI can
 * inline. Manifests without a `settings` block (or a malformed one) get the
 * input forwarded unchanged — keeps third-party authors that haven't
 * declared settings yet from being rejected.
 */
async function validateInstallSettings(opts: {
  manifest: Record<string, unknown>;
  approvedScopes: string[];
  settings: unknown;
  forModelId: number;
}): Promise<Record<string, unknown> | undefined> {
  const { manifest, approvedScopes, settings, forModelId } = opts;
  if (settings == null) return undefined;

  const parsedManifestSettings = manifestSettingsSchema.safeParse(manifest.settings ?? {});
  // Malformed manifest settings → forward the raw input through. The
  // manifest validation gate at submission time should have caught this;
  // failing closed here would break a previously-accepted install just
  // because the manifest later drifted out of spec.
  if (!parsedManifestSettings.success) return settings as Record<string, unknown>;

  let validated = validateBlockSettings({
    manifestSettings: parsedManifestSettings.data,
    inputSettings: settings as Record<string, unknown>,
    declaredScopes: approvedScopes,
    forScope: 'publisher',
  });

  // Cross-row validation for the resource_picker → checkpoint case. Known
  // field name across blocks that target image generation. For LoRA-bound
  // installs the checkpoint must be in the same family — gates a publisher
  // accidentally pinning an SDXL checkpoint on a Flux LoRA.
  const checkpointId = validated.default_checkpoint_version_id;
  if (typeof checkpointId === 'number') {
    const baseModel = await getRepresentativeBaseModel(forModelId);
    if (!baseModel) {
      // No published versions yet — can't validate the ecosystem. Strip
      // the field so the install row stays consistent (a value that can't
      // be validated later will BAD_REQUEST at submit time anyway).
      const { default_checkpoint_version_id: _, ...rest } = validated;
      validated = rest;
    } else {
      await validateBlockCheckpoint({
        checkpointVersionId: checkpointId,
        forBaseModel: baseModel,
        reason: 'publisher-default',
      });
    }
  }

  return validated;
}
