import * as z from 'zod';

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
 * base model the block would otherwise show on. Empty arrays are normalised
 * to null at the service layer so the SQL `array_length(... , 1) IS NULL`
 * path catches them.
 */
export const subscriptionTargetsSchema = z.object({
  targetModelTypes: z.array(z.string().min(1).max(32)).max(16).nullable(),
  targetBaseModels: z.array(z.string().min(1).max(64)).max(32).nullable(),
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
  })
  .merge(subscriptionTargetsSchema)
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
export type SubscriptionRecord = {
  id: string;
  scope: SubscriptionScope;
  appBlockId: string;
  blockId: string;
  appId: string;
  targetModelTypes: string[] | null;
  targetBaseModels: string[] | null;
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
 * Marketplace listing shape. install_count includes per-model installs and
 * (someday) subscription rows — for v1 it's the per-model installs only;
 * subscriptions land later in the same column with a small SQL change.
 */
export type AvailableBlock = {
  id: string;
  blockId: string;
  appId: string;
  appName: string | null;
  manifest: Record<string, unknown>;
  installCount: number;
};

export const listAvailableSchema = z.object({
  slotId: z
    .enum(['model.sidebar_top', 'model.below_images', 'model.actions_extra'])
    .optional(),
  query: z.string().max(200).optional(),
  cursor: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type ListAvailableInput = z.infer<typeof listAvailableSchema>;
