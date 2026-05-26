import * as z from 'zod';

/**
 * The four blockInstanceId prefixes resolve to four distinct install
 * surfaces. See BlockRegistry.resolveBlockInstance for the resolver and
 * docs/features/app-blocks.md for the full precedence rules.
 */
export const blockAttributionScopeSchema = z.enum([
  'per_model_install',       // mbi_* — model_block_installs row
  'publisher_all_my_models', // bus_pub_* — block_user_subscriptions (publisher scope)
  'viewer_personal',         // bus_view_* — block_user_subscriptions (viewer scope)
  'platform_default',        // pdb_* — platform_default_blocks
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
} as const;

/**
 * Derive the attribution scope from the blockInstanceId prefix. The
 * substrate uses prefixed ULIDs everywhere; this resolver is the only
 * code path that needs to map prefix → scope. Keep it in lockstep with
 * BlockRegistry.resolveBlockInstance.
 */
export function deriveScopeFromInstanceId(
  blockInstanceId: string
): BlockAttributionScope | null {
  if (blockInstanceId.startsWith('mbi_')) return 'per_model_install';
  if (blockInstanceId.startsWith('bus_pub_')) return 'publisher_all_my_models';
  if (blockInstanceId.startsWith('bus_view_')) return 'viewer_personal';
  if (blockInstanceId.startsWith('pdb_')) return 'platform_default';
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
  };
  const parsed = blockAttributionSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}
