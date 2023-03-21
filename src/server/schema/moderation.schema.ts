import { z } from 'zod';

export type UpdatePreferencesSchema = z.infer<typeof updatePreferencesSchema>;
export const updatePreferencesSchema = z.record(z.boolean());
