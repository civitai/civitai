import * as z from 'zod';

/**
 * Keys that are never stored in a preset.
 *
 * Kept in sync with the client-side PRESET_EXCLUDED_KEYS. Changes to either
 * side must update the other — a value excluded on save must not mark the
 * preset dirty on the client.
 */
export const PRESET_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  'images',
  'video',
  'priority',
  'outputFormat',
  'quantity',
  'output',
  'input',
]);

export const presetValuesSchema = z
  .record(z.string(), z.unknown())
  .refine((v) => typeof v.ecosystem === 'string' && v.ecosystem.length > 0, {
    error: 'Preset values must include an ecosystem',
  });
export type PresetValues = z.infer<typeof presetValuesSchema>;

export const getPresetsForEcosystemInputSchema = z.object({
  ecosystem: z.string().min(1),
});
export type GetPresetsForEcosystemInput = z.infer<typeof getPresetsForEcosystemInputSchema>;

export const createGenerationPresetInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().nullable(),
  values: presetValuesSchema,
});
export type CreateGenerationPresetInput = z.infer<typeof createGenerationPresetInputSchema>;

export const updateGenerationPresetInputSchema = z.object({
  id: z.number(),
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  values: presetValuesSchema.optional(),
});
export type UpdateGenerationPresetInput = z.infer<typeof updateGenerationPresetInputSchema>;

export const reorderGenerationPresetsInputSchema = z.object({
  orderedIds: z.array(z.number()).min(1),
});
export type ReorderGenerationPresetsInput = z.infer<typeof reorderGenerationPresetsInputSchema>;
