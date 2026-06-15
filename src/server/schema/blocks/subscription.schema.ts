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
};

/** Field names projected from the raw manifest into PublicBlockManifest. */
export const PUBLIC_MANIFEST_FIELDS = ['name', 'description', 'targets'] as const;

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
  return out;
}

/**
 * F-E E3 marketplace sort options:
 *   - `popular` (default) — install_count DESC (distinct-user installs).
 *   - `newest`            — current_version_deployed_at DESC, falling back to
 *                           created_at for pre-W2 rows with no deploy timestamp.
 *   - `name`              — manifest name ASC (case-insensitive).
 */
export const marketplaceSortSchema = z.enum(['popular', 'newest', 'name']);
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
  // F-E E3: sort order; defaults to popular (install_count desc) — same as the
  // pre-E3 fixed ordering, so the default behaviour is unchanged.
  sort: marketplaceSortSchema.default('popular'),
  cursor: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type ListAvailableInput = z.infer<typeof listAvailableSchema>;

/** Input for the anon-capable `blocks.getAppDetail` (F-E E2). */
export const getAppDetailSchema = z.object({
  appBlockId: z.string().min(1).max(64),
});
export type GetAppDetailInput = z.infer<typeof getAppDetailSchema>;

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
 *
 * Add a field here ONLY after confirming it is publisher-display-safe for anon.
 */
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
  liveUrl: string;
};
