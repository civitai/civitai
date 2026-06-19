import * as z from 'zod';

/**
 * The four blockInstanceId prefixes resolve to four distinct install
 * surfaces. See BlockRegistry.resolveBlockInstance for the resolver and
 * docs/features/app-blocks.md for the full precedence rules.
 */
export const blockAttributionScopeSchema = z.enum([
  // Retained for historical attribution rows + as a rate-card key. Since the
  // 2026-05-30 kill_per_model_installs migration this is NO LONGER emitted for
  // new attributions — the per-model-pinned shape is a block_user_subscriptions
  // row whose stored scope is `publisher_all_my_models`, so mbi_*/bki_* now
  // derive to publisher_all_my_models (see deriveScopeFromInstanceId).
  'per_model_install',       // legacy — model_block_installs (table dropped)
  'publisher_all_my_models', // bus_pub_* (blanket) + mbi_*/bki_* (per-model-pinned) — block_user_subscriptions
  'viewer_personal',         // bus_view_* — block_user_subscriptions (viewer scope)
  'platform_default',        // pdb_* — platform_default_blocks
  // W10 full-page apps (`app.page` slot, entity=none). A page is a stateless,
  // viewer-chosen full-page surface with NO model entity and NO install row —
  // its synthetic instanceId is `page_<appBlockId>` (see block-tokens page
  // mint). A Buzz PURCHASE made inside a page resolves to this scope.
  // Placeholder publisher share is 0% (page revenue is largely
  // platform-counterfactual); raise via a future rate card after monetization
  // sign-off. See deriveScopeFromInstanceId + SOURCE_TO_SCOPE['page'].
  'viewer_global',           // page_* — pages (resolvePageBlock, entity=none)
]);
export type BlockAttributionScope = z.infer<typeof blockAttributionScopeSchema>;

/**
 * Wire shape passed from IframeHost → BuyBuzzModal → payment-provider
 * metadata. The iframe NEVER provides any of these fields itself — the
 * host derives them from the install record so the block cannot forge
 * attribution to a different app/instance.
 *
 * `modelId` is optional analytics ("publisher install on model X drove
 * the conversion") and never participates in revenue calc.
 */
export const blockAttributionSchema = z.object({
  appId: z.string().min(1).max(64),
  appBlockId: z.string().min(1).max(64),
  blockInstanceId: z.string().min(1).max(64),
  scope: blockAttributionScopeSchema,
  modelId: z.number().int().positive().optional(),
  /**
   * Slot the install surfaced in (e.g. `model.sidebar_top`). Carried so
   * the server can re-validate the instance via
   * `BlockRegistry.resolveBlockInstance`, which requires a (modelId,
   * slotId) pair. Client-supplied and therefore UNTRUSTED — a forged slot
   * simply fails to resolve and the whole attribution is stripped, so it
   * cannot be used to mint earnings. Optional for backwards-compat with
   * any in-flight client that predates the FIN-1 hardening; absent → the
   * server can't re-validate → attribution stripped (fail-safe).
   */
  slotId: z.string().min(1).max(128).optional(),
});
export type BlockAttribution = z.infer<typeof blockAttributionSchema>;

/**
 * Stripe metadata is `Record<string, string>` — every value must be a
 * string and there's a 50-key / 500-char-per-value cap. We namespace all
 * attribution keys with `block` so the buzz-purchase webhook can
 * conditionally pull them out without colliding with other metadata
 * carried on the same payment intent.
 */
export const ATTRIBUTION_METADATA_KEYS = {
  appId: 'blockAppId',
  appBlockId: 'blockAppBlockId',
  blockInstanceId: 'blockInstanceId',
  scope: 'blockScope',
  modelId: 'blockModelId',
  slotId: 'blockSlotId',
} as const;

/**
 * Derive the attribution scope from the blockInstanceId prefix. The
 * substrate uses prefixed ULIDs everywhere; this resolver is the only
 * client-side code path that needs to map prefix → scope. Keep it in
 * lockstep with the server's authoritative `SOURCE_TO_SCOPE` map in
 * attribution-validator.service.ts (the server re-derives + overrides the
 * client value, so a drift here only produces log noise — but the publisher
 * earnings bucket is decided by SOURCE_TO_SCOPE, so they must agree).
 *
 * Post 2026-05-30 kill_per_model_installs: `mbi_*`/`bki_*` are NO LONGER
 * per-model-install rows (that table is gone). They are per-model-PINNED
 * `block_user_subscriptions` rows whose stored scope is
 * `publisher_all_my_models` (resolveBlockInstance rejects any other scope
 * for these prefixes), so they share the publisher earnings bucket with the
 * blanket `bus_pub_*` shape instead of splitting into the stale
 * `per_model_install` bucket.
 */
export function deriveScopeFromInstanceId(
  blockInstanceId: string
): BlockAttributionScope | null {
  if (blockInstanceId.startsWith('mbi_') || blockInstanceId.startsWith('bki_')) {
    return 'publisher_all_my_models';
  }
  if (blockInstanceId.startsWith('bus_pub_')) return 'publisher_all_my_models';
  if (blockInstanceId.startsWith('bus_view_')) return 'viewer_personal';
  if (blockInstanceId.startsWith('pdb_')) return 'platform_default';
  // W10 page surface — `page_<appBlockId>` (the synthetic page mint id). A page
  // has no model entity; the purchase attributes to the page app's author at
  // the `viewer_global` scope. Kept in lockstep with the server's
  // SOURCE_TO_SCOPE['page'] re-derivation (the server is authoritative).
  if (blockInstanceId.startsWith('page_')) return 'viewer_global';
  return null;
}

/**
 * Encode attribution into a flat string-keyed map suitable for Stripe
 * `metadata`, Paddle `custom_data`, or any provider that demands a flat
 * string bag. Returns `null` when there's no attribution to stamp so
 * the caller can spread it conditionally without churning metadata for
 * non-block purchases.
 */
export function encodeAttributionMetadata(
  attribution: BlockAttribution | null | undefined
): Record<string, string> | null {
  if (!attribution) return null;
  const out: Record<string, string> = {
    [ATTRIBUTION_METADATA_KEYS.appId]: attribution.appId,
    [ATTRIBUTION_METADATA_KEYS.appBlockId]: attribution.appBlockId,
    [ATTRIBUTION_METADATA_KEYS.blockInstanceId]: attribution.blockInstanceId,
    [ATTRIBUTION_METADATA_KEYS.scope]: attribution.scope,
  };
  if (attribution.modelId != null) {
    out[ATTRIBUTION_METADATA_KEYS.modelId] = String(attribution.modelId);
  }
  if (attribution.slotId != null && attribution.slotId !== '') {
    out[ATTRIBUTION_METADATA_KEYS.slotId] = attribution.slotId;
  }
  return out;
}

/**
 * Pull attribution back off a flat metadata map. Returns `null` when no
 * attribution keys are present — that's the steady-state for every
 * non-block buzz purchase. When keys ARE present we apply the schema
 * (which rejects malformed values) so a bad write upstream surfaces at
 * the webhook layer rather than silently corrupting the attribution row.
 */
export function extractAttribution(
  metadata: Record<string, string | number | null | undefined> | null | undefined
): BlockAttribution | null {
  if (!metadata) return null;
  const appId = metadata[ATTRIBUTION_METADATA_KEYS.appId];
  if (appId == null || appId === '') return null;

  const raw = {
    appId: String(appId),
    appBlockId: String(metadata[ATTRIBUTION_METADATA_KEYS.appBlockId] ?? ''),
    blockInstanceId: String(metadata[ATTRIBUTION_METADATA_KEYS.blockInstanceId] ?? ''),
    scope: String(metadata[ATTRIBUTION_METADATA_KEYS.scope] ?? ''),
    modelId:
      metadata[ATTRIBUTION_METADATA_KEYS.modelId] != null &&
      metadata[ATTRIBUTION_METADATA_KEYS.modelId] !== ''
        ? Number(metadata[ATTRIBUTION_METADATA_KEYS.modelId])
        : undefined,
    slotId:
      metadata[ATTRIBUTION_METADATA_KEYS.slotId] != null &&
      metadata[ATTRIBUTION_METADATA_KEYS.slotId] !== ''
        ? String(metadata[ATTRIBUTION_METADATA_KEYS.slotId])
        : undefined,
  };
  const parsed = blockAttributionSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}
