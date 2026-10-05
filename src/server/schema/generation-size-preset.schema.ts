import * as z from 'zod';

/** Saved sizes are one list per user, offered on every model they fit. */
export const MAX_SIZE_PRESETS = 12;

/** Shape only; the service checks the size against the custom limits. */
export const addSizePresetInputSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type AddSizePresetInput = z.infer<typeof addSizePresetInputSchema>;
