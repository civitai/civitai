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
