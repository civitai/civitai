import * as z from 'zod';

/**
 * Per-block typed settings shapes. The router's generic `settingsSchema`
 * only checks size + JSON-validity; this layer adds per-block-id field
 * validation for first-party blocks. External blocks fall through to the
 * generic schema (their settings remain a free-form record).
 *
 * Cross-row validation (e.g. "the checkpoint must be in the same ecosystem
 * as the LoRA") lives in `checkpoint.service.ts` — that needs DB reads and
 * can't run as part of a zod parse.
 */

const BUZZ_BUDGET_MAX = 1000;

export type GenerateFromModelSettings = z.infer<typeof generateFromModelSettingsSchema>;
export const generateFromModelSettingsSchema = z.object({
  buzz_budget_per_gen: z.number().int().min(1).max(BUZZ_BUDGET_MAX).optional(),
  // Optional: present for LoRA installs where the model author has picked a
  // platform Checkpoint to anchor generations. For Checkpoint installs the
  // model is its own checkpoint and this field is ignored.
  default_checkpoint_version_id: z.number().int().positive().optional(),
});

export type BlockUserSettings = z.infer<typeof blockUserSettingsSchema>;
export const blockUserSettingsSchema = z.object({
  // Nullable instead of optional: explicit `null` clears the override and
  // falls back to the publisher default. `undefined` is treated as "don't
  // touch this field" — important once we add more per-viewer fields.
  checkpoint_version_id: z.number().int().positive().nullable().optional(),
});

/**
 * Lookup of first-party block IDs to their typed settings schemas. The
 * router parses the input through whichever entry matches the install's
 * `appBlock.blockId`; misses fall back to the generic record schema.
 *
 * Keep the keys in sync with the manifest's `blockId` field — these are
 * publisher-supplied identifiers, not internal db ids.
 */
export const blockSettingsSchemaByBlockId: Record<string, z.ZodTypeAny> = {
  'generate-from-model': generateFromModelSettingsSchema,
};
