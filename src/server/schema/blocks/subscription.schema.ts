import * as z from 'zod';
import { MARKETPLACE_CATEGORIES } from '~/server/services/blocks/marketplace-categories.constants';

/**
 * Two user-controlled install scopes. Both live in the same
 * `block_user_subscriptions` table.
 *   - `publisher_all_my_models`: model owner subscribes the block to every
 *     model they own. The listForModel SQL joins on Model.userId.
 *   - `viewer_personal`: any authenticated user subscribes the block to
 *     every model page they visit. The SQL joins on the current viewer's
 *     userId.
 */
export const subscriptionScopeSchema = z.enum([
  'publisher_all_my_models',
  'viewer_personal',
]);
export type SubscriptionScope = z.infer<typeof subscriptionScopeSchema>;

/**
 * Optional target filters. `null` or `[]` = applies to every model type /
 * base model / model the block would otherwise show on. Empty arrays are
 * normalised to null at the service layer so the SQL
 * `array_length(... , 1) IS NULL` path catches them.
 *
 * `targetModelIds` (since the 2026-05-30 kill_per_model_installs migration
 * absorbed `model_block_installs` into this table) lets a subscription
 * pin to specific models. The three filters AND together at listForModel
 * time: a model matches iff
 *   (targetModelTypes empty OR model.type in list) AND
 *   (targetBaseModels empty OR model.baseModel in list) AND
 *   (targetModelIds empty   OR model.id in list).
 */
export const subscriptionTargetsSchema = z.object({
  targetModelTypes: z.array(z.string().min(1).max(32)).max(16).nullable(),
  targetBaseModels: z.array(z.string().min(1).max(64)).max(32).nullable(),
  targetModelIds: z.array(z.number().int().positive()).max(64).nullable().default(null),
});

/**
 * Wire shape for `blocks.upsertSubscription`. Settings are validated through
 * the per-block-id schema map at the service layer; the router-level shape
 * accepts a generic record (with the 4KB size cap applied via refine).
 */
export const upsertSubscriptionSchema = z
  .object({
    appBlockId: z.string().min(1).max(64),
    scope: subscriptionScopeSchema,
    settings: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean().default(true),
    ...subscriptionTargetsSchema.shape,
  })
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value.settings), 'utf8') <= 4096,
    { message: 'settings exceeds 4KB', path: ['settings'] }
  );
export type UpsertSubscriptionInput = z.infer<typeof upsertSubscriptionSchema>;

/**
 * Wire shape returned by `blocks.listMySubscriptions`. Denormalises the
 * app_block row so the management UI can render block name/icon without a
 * second round-trip.
 */
/**
 * One subscription on the wire — denormalised app_block row + per-target
 * model name(s) for the pinned shape.
 *
 * Pinned vs blanket: `slotId !== null && targetModelIds !== null` means
 * the subscription is the per-model-install shape (was `model_block
 * _installs` before the 2026-05-30 absorb). Blanket subscriptions have
 * both fields null.
 *
 * `pinnedModelNames` is a side-table lookup so the UI can render
 * "Pinned to: <Model Name>" badges without a second round-trip. Null
 * for blanket; map of modelId → name for pinned.
 *
 * `pinnedVersion` and `blockInstanceId` come from the same migration —
 * the host uses pinnedVersion to swap which manifest version it loads,
 * and blockInstanceId is the stable id downstream tables key on (NULL
 * for blanket subs; non-NULL for migrated/pinned subs).
 *
 * `availableVersions` is the list of approved publish_request versions
 * for the underlying app, newest-first. Empty when the app has no
 * recorded publish requests (pre-W1 hackathon rows). Powers the version
 * Select on /apps/installed for pinned subscriptions.
 */
export type SubscriptionRecord = {
  id: string;
  scope: SubscriptionScope;
  appBlockId: string;
  blockId: string;
  appId: string;
  targetModelTypes: string[] | null;
  targetBaseModels: string[] | null;
  targetModelIds: number[] | null;
  pinnedModelNames: Record<number, string> | null;
  slotId: string | null;
  pinnedVersion: string | null;
  blockInstanceId: string | null;
  currentVersion: string | null;
  availableVersions: { version: string; approvedAt: Date | null }[];
  settings: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  manifest: {
    name?: string;
    description?: string;
    targets?: Array<{ slotId?: string }>;
    [key: string]: unknown;
  };
};

/**
 * PUBLIC marketplace manifest subset (F-E E1 anon-exposure allowlist).
 *
 * The stored `app_blocks.manifest` jsonb is arbitrary publisher-supplied JSON
 * plus server-SET internal fields (e.g. `trustTier`, the internal `iframe.src`
 * host, `renderMode`). It must NEVER be shipped wholesale to an anon caller.
 * The marketplace listing is anon-capable, so we project ONLY this vetted,
 * display-safe subset:
 *   - `name`        — the human display name (already shown on the card).
 *   - `description` — the short marketing blurb (shown on the card).
 *   - `targets`     — only the `slotId` of each declared target (drives the
 *                     slot badge + slot filter). Any other per-target field is
 *                     dropped so config details can't leak.
 * Add a field here ONLY after confirming it is publisher-display-safe for anon.
 */
export type PublicBlockManifest = {
  name?: string;
  description?: string;
  targets?: Array<{ slotId?: string }>;
  /**
   * W10 — whether the app declares a full-page surface (opens at
   * `/apps/run/<slug>`). A boolean ONLY (never the page path/internals) so the
   * marketplace can show an "Open app" affordance without leaking config.
   */
  hasPage?: boolean;
};

/** Field names projected from the raw manifest into PublicBlockManifest. */
export const PUBLIC_MANIFEST_FIELDS = ['name', 'description', 'targets', 'hasPage'] as const;

/**
 * Marketplace listing shape. install_count includes per-model installs and
 * (someday) subscription rows — for v1 it's the per-model installs only;
 * subscriptions land later in the same column with a small SQL change.
 *
 * `manifest` is the PUBLIC allowlist subset only (see PublicBlockManifest) —
 * not the raw stored manifest. This shape is returned by the anon-capable
 * `blocks.listAvailable` (F-E E1), so it must carry no private/internal data.
 *
 * F-E E3 additions (still anon-safe):
 *   - `category`      — the mod-assigned marketplace category (free-text
 *                       `app_blocks.category` column; NULL until the E3 migration
 *                       is applied + a mod sets one). Public, display-only.
 *   - `scopesSummary` — the FIRST N of the app's APPROVED scope ids
 *                       (`approved_scopes` column) — the permission-disclosure
 *                       preview shown on the card, mirroring E2's getAppDetail
 *                       `scopes`. These are plain scope identifier strings
 *                       describing what the app can do (the whole point of the
 *                       disclosure) — never the raw manifest declaration.
 *   - `coverUrl`      — the FIRST publisher-supplied screenshot's PUBLIC display
 *                       URL (`toPublicScreenshots(id, screenshots)[0]?.url`),
 *                       surfaced as the card's cover image. NULL when the app
 *                       shipped no `screenshots/` dir. Same opaque, gated app
 *                       route (`/api/blocks/screenshot/<id>/<index>.<ext>`) the
 *                       detail page uses — the raw MinIO key is NEVER exposed.
 */
export type AvailableBlock = {
  id: string;
  blockId: string;
  appId: string;
  appName: string | null;
  manifest: PublicBlockManifest;
  installCount: number;
  category: string | null;
  scopesSummary: string[];
  // Off-site (external-link) app — PURE EXTERNAL LINK. When non-null, this
  // listing opens an external URL in a new tab (NO install / scopes / token /
  // subscription). The card uses this as the "open" target instead of the
  // computed `https://<slug>.<APPS_DOMAIN>` liveUrl, hides Install + scopes, and
  // flags the app as off-site. NULL = a normal on-platform app. Always https://.
  externalUrl: string | null;
  // Marketplace reviews (F-E "marketplace" cluster). avgRating is NULL when the
  // app has no aggregate-eligible reviews (0-review apps); reviewCount excludes
  // mod-excluded + self-reviews. Both display-safe (aggregate numbers only).
  avgRating: number | null;
  reviewCount: number;
  // Card cover image: the FIRST publisher-supplied screenshot's PUBLIC display
  // URL, or NULL when the app shipped no screenshots. Built via the SAME
  // `toPublicScreenshots` projection the detail page uses (opaque gated route,
  // never the raw MinIO key) — display-only. OPTIONAL: both producers
  // (listAvailable/getFeaturedBlocks) always set it to `string | null`, but a
  // nullable display field is left optional so test fixtures built via
  // `Partial<AvailableBlock>` spread (which widens to `| undefined`) typecheck;
  // the card treats absent the same as null (renders the placeholder).
  coverUrl?: string | null;
};

/**
 * Projects a raw stored manifest down to the public allowlist subset. Defensive
 * against arbitrary publisher JSON: reads only the allowlisted fields, coerces
 * each to its expected display type, and drops everything else. Centralised so
 * the listing + (future E2 detail) paths share ONE projection and can't drift.
 */
export function toPublicBlockManifest(raw: unknown): PublicBlockManifest {
  const m = (raw ?? {}) as Record<string, unknown>;
  const out: PublicBlockManifest = {};
  if (typeof m.name === 'string') out.name = m.name;
  if (typeof m.description === 'string') out.description = m.description;
  if (Array.isArray(m.targets)) {
    out.targets = m.targets
      .map((t) => {
        const slotId = (t as { slotId?: unknown } | null | undefined)?.slotId;
        return typeof slotId === 'string' ? { slotId } : null;
      })
      .filter((t): t is { slotId: string } => t !== null);
  }
  // W10 — surface ONLY a boolean: does the manifest declare a usable page
  // (a `page` object with a non-empty string `path`)? Never the path itself.
  const page = (m.page ?? null) as { path?: unknown } | null;
  if (page && typeof page === 'object' && typeof page.path === 'string' && page.path.length > 0) {
    out.hasPage = true;
  }
  return out;
}

/**
 * F-E marketplace sort options:
 *   - `rating` (DEFAULT) — Bayesian-shrinkage avg rating DESC (a few-review 5★
 *                          app can't outrank a many-review 4.x app; 0-review
 *                          apps sit mid-pack at the global mean `m`). Ties fall
 *                          back to install_count then id.
 *   - `popular`          — install_count DESC (distinct-user installs).
 *   - `newest`           — current_version_deployed_at DESC, falling back to
 *                          created_at for pre-W2 rows with no deploy timestamp.
 *   - `name`             — manifest name ASC (case-insensitive).
 */
export const marketplaceSortSchema = z.enum(['rating', 'popular', 'newest', 'name']);
export type MarketplaceSort = z.infer<typeof marketplaceSortSchema>;

export const listAvailableSchema = z.object({
  slotId: z
    .enum(['model.sidebar_top', 'model.below_images', 'model.actions_extra'])
    .optional(),
  query: z.string().max(200).optional(),
  // F-E E3: mod-assigned category filter. Validated against the single-source
  // taxonomy const (MARKETPLACE_CATEGORIES) so the schema and the UI/DB share
  // ONE list — adding a category is a one-line const edit, no schema migration.
  category: z.enum(MARKETPLACE_CATEGORIES).optional(),
  // F-E marketplace: sort order; defaults to `rating` (Bayesian-shrinkage avg
  // rating desc) so the best-reviewed apps surface first; 0-review apps sit
  // mid-pack at the global mean (not unfairly buried).
  sort: marketplaceSortSchema.default('rating'),
  cursor: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type ListAvailableInput = z.infer<typeof listAvailableSchema>;

/** Input for the anon-capable `blocks.getAppDetail` (F-E E2). */
export const getAppDetailSchema = z.object({
  appBlockId: z.string().min(1).max(64),
});
export type GetAppDetailInput = z.infer<typeof getAppDetailSchema>;

// ---------------------------------------------------------------------------
// F-E E4 — curation (featured rail + mod-set marketplace metadata).
// ---------------------------------------------------------------------------

/**
 * Input for the public, anon-capable `blocks.getFeaturedBlocks` (F-E E4
 * featured rail). Only a `limit` — the featured set is the curated staff-pick
 * list, so there's no client-controlled filter/sort (the order is the
 * mod-assigned `featured_order`). Same exposure posture as `listAvailable`:
 * approved-only, the `AvailableBlock` public allowlist, mod-gated until launch.
 */
export const getFeaturedBlocksSchema = z.object({
  limit: z.number().int().min(1).max(24).default(12),
});
export type GetFeaturedBlocksInput = z.infer<typeof getFeaturedBlocksSchema>;

/**
 * Input for the MOD-ONLY `blocks.setMarketplaceMeta` (F-E E4 curation write).
 * Sets the platform-controlled marketplace metadata on ONE app_block. All three
 * fields are optional so a mod can patch any subset (e.g. just toggle
 * `featured`); an omitted field is left unchanged at the service layer.
 *
 *   - `category`      — a value from the single-source taxonomy const
 *                       (`MARKETPLACE_CATEGORIES`) OR `null` to clear it. The
 *                       enum validation refuses any value outside the taxonomy.
 *   - `featured`      — the staff-pick toggle (the featured rail filter).
 *   - `featuredOrder` — the rail sort position (lower = earlier), or `null` to
 *                       clear. Int only.
 *
 * NOTE: `category` uses `.nullable()` (not `.optional()` alone) so the client
 * can explicitly CLEAR it (send `null`). We distinguish "omitted" (undefined →
 * leave unchanged) from "clear" (null → set to NULL) at the service layer.
 */
export const setMarketplaceMetaSchema = z.object({
  appBlockId: z.string().min(1).max(64),
  category: z.enum(MARKETPLACE_CATEGORIES).nullable().optional(),
  featured: z.boolean().optional(),
  featuredOrder: z.number().int().min(0).max(100000).nullable().optional(),
});
export type SetMarketplaceMetaInput = z.infer<typeof setMarketplaceMetaSchema>;

/** Input for the MOD-ONLY `blocks.getMarketplaceMeta` (seeds the curation UI). */
export const getMarketplaceMetaSchema = z.object({
  appBlockId: z.string().min(1).max(64),
});
export type GetMarketplaceMetaInput = z.infer<typeof getMarketplaceMetaSchema>;

// ---------------------------------------------------------------------------
// F-E marketplace REVIEWS (5-star) — schemas.
// ---------------------------------------------------------------------------

/** Upsert (create-or-update) the viewer's review for an app block. */
export const upsertAppBlockReviewSchema = z.object({
  appBlockId: z.string().min(1).max(64),
  rating: z.number().int().min(1).max(5), // STARS
  recommended: z.boolean().optional(),
  details: z.string().max(10000).nullish(),
});
export type UpsertAppBlockReviewInput = z.infer<typeof upsertAppBlockReviewSchema>;

/** Keyset-paginated list of an app's reviews (newest first). */
export const listAppBlockReviewsSchema = z.object({
  appBlockId: z.string().min(1).max(64),
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type ListAppBlockReviewsInput = z.infer<typeof listAppBlockReviewsSchema>;

/** MOD-ONLY: flip `exclude` on a review (keeps abuse out of the aggregate). */
export const setAppReviewExcludedSchema = z.object({
  id: z.number().int().positive(),
  exclude: z.boolean(),
});
export type SetAppReviewExcludedInput = z.infer<typeof setAppReviewExcludedSchema>;

/**
 * MOD-ONLY current marketplace metadata for one app_block — returned by
 * `blocks.getMarketplaceMeta` so the review-page curation form can render the
 * current category/featured/order. Carries `status` (mod-relevant: featuring is
 * only allowed for `approved`) — this is a moderator surface, NOT the anon
 * `AvailableBlock`/`PublicAppDetail` allowlist, so a mod-only field is fine.
 */
export type MarketplaceMeta = {
  appBlockId: string;
  status: string;
  category: string | null;
  featured: boolean;
  featuredOrder: number | null;
};

/**
 * PUBLIC per-app detail shape returned by the anon-capable
 * `blocks.getAppDetail` (F-E E2 marketplace detail page).
 *
 * 🔒 ANON-EXPOSURE ALLOWLIST. This is shipped to a session-less caller (behind
 * the mod-segmented flag — dark today), so it must carry ONLY public,
 * display-safe data. It is a deliberately NARROW superset of the listing shape
 * (`AvailableBlock`) — every added field below is publisher-display-safe:
 *   - `manifest`     — the SAME `PublicBlockManifest` allowlist as the listing
 *                      (via `toPublicBlockManifest`); the raw stored manifest
 *                      (with `trustTier`, internal `iframe.src`, `renderMode`,
 *                      settings internals, raw `scopes`) is NEVER shipped.
 *   - `scopes`       — the app's APPROVED scope ids (`approved_scopes` column),
 *                      surfaced so the detail page can render the permission
 *                      disclosure via SCOPE_DESCRIPTIONS. These are plain scope
 *                      identifier strings (e.g. `ai:write:budgeted`), not the
 *                      manifest's internal declaration — safe to disclose since
 *                      they describe what the app can do, which is the whole
 *                      point of the disclosure.
 *   - `contentRating`— the platform content-rating string (already gates which
 *                      slots a block may mount; display-safe).
 *   - `version`      — the approved version string.
 *   - `installCount` — distinct-user install count (same as the listing).
 *   - `liveUrl`      — the PUBLIC standalone block URL (`https://<slug>.<APPS_
 *                      DOMAIN>`), the same already-public origin the host
 *                      iframes. Built server-side from the blockId + APPS_DOMAIN
 *                      so the client never needs the domain. No token, no scope.
 *   - `screenshots`  — F-E E5 publisher-supplied screenshot gallery. ONLY the
 *                      public DISPLAY URL of each screenshot (served by the gated
 *                      `/api/blocks/screenshot/<appBlockId>/<index>.<ext>` route)
 *                      + its index/contentType. These images were auto-discovered
 *                      from the bundle, magic-byte-validated, and MOD-REVIEWED
 *                      before approval — display-safe public data. The underlying
 *                      MinIO key is NOT exposed (the URL is an opaque app route).
 *                      Empty array when the app shipped no `screenshots/` dir.
 *
 * Add a field here ONLY after confirming it is publisher-display-safe for anon.
 */
export type PublicScreenshot = {
  index: number;
  url: string;
  contentType: string;
};

/** The accepted public screenshot content-types — anything else is dropped so a
 *  stored record can never coerce the client into a non-image rendering. */
const PUBLIC_SCREENSHOT_CONTENT_TYPES = new Set(['image/png', 'image/webp', 'image/jpeg']);
const PUBLIC_SCREENSHOT_EXTS = new Set(['png', 'webp', 'jpg', 'jpeg']);

/**
 * F-E E5 — project the raw stored `app_blocks.screenshots` jsonb (an array of
 * `{ key, index, ext, contentType }`) into the PUBLIC gallery shape: ONLY a
 * display URL + index + content-type. The underlying MinIO `key` is NEVER
 * exposed — the URL is the opaque, gated `/api/blocks/screenshot/<appBlockId>/
 * <index>.<ext>` app route. Defensive against arbitrary/legacy jsonb:
 *   - drops any entry whose index isn't a non-negative int,
 *   - drops any entry whose ext/contentType isn't in the image allowlist (so a
 *     tampered/legacy row can't smuggle a non-image content-type to the client),
 *   - builds the URL from appBlockId + index + ext server-side (never trusts a
 *     stored URL/key), so a malicious key in the column can't redirect the img.
 * Returns [] for NULL / non-array / all-invalid.
 */
export function toPublicScreenshots(appBlockId: string, raw: unknown): PublicScreenshot[] {
  if (!Array.isArray(raw)) return [];
  const out: PublicScreenshot[] = [];
  for (const entry of raw) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const index = e.index;
    const ext = typeof e.ext === 'string' ? e.ext.toLowerCase() : '';
    const contentType = typeof e.contentType === 'string' ? e.contentType : '';
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue;
    if (!PUBLIC_SCREENSHOT_EXTS.has(ext)) continue;
    if (!PUBLIC_SCREENSHOT_CONTENT_TYPES.has(contentType)) continue;
    out.push({
      index,
      // Server-built opaque app route — never the stored key/url. encodeURIComponent
      // the id defensively (it's a ULID-shaped PK, but be safe).
      url: `/api/blocks/screenshot/${encodeURIComponent(appBlockId)}/${index}.${ext}`,
      contentType,
    });
  }
  // Stable display order by index.
  out.sort((a, b) => a.index - b.index);
  return out;
}

export type PublicAppDetail = {
  id: string;
  blockId: string;
  appId: string;
  appName: string | null;
  manifest: PublicBlockManifest;
  scopes: string[];
  contentRating: string | null;
  version: string | null;
  installCount: number;
  // Marketplace reviews (aggregate-eligible). avgRating NULL = 0-review app.
  avgRating: number | null;
  reviewCount: number;
  liveUrl: string;
  screenshots: PublicScreenshot[];
  // Off-site (external-link) app — PURE EXTERNAL LINK. When non-null, the detail
  // surfaces this as the primary CTA (open in a new tab) and hides install /
  // scopes / iframe-preview. NULL = a normal on-platform app (liveUrl is the
  // canonical standalone origin as before). Always https://.
  externalUrl: string | null;
};
