import * as z from 'zod';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';

// A blurb is a footer or a settings block, not an article. The cap is what stops one
// blurb's text becoming a large multiple of itself across every entity using it.
export const MAX_BLURB_LENGTH = 3000;

const blurbContentSchema = getSanitizedStringSchema().refine(
  (v) => v.length <= MAX_BLURB_LENGTH,
  `Blurbs are limited to ${MAX_BLURB_LENGTH} characters.`
);

export const createBlurbInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  content: blurbContentSchema,
});

export const updateBlurbInputSchema = z.object({
  id: z.number(),
  content: blurbContentSchema,
});

export const deleteBlurbInputSchema = z.object({ id: z.number() });

export type CreateBlurbInput = z.infer<typeof createBlurbInputSchema>;
export type UpdateBlurbInput = z.infer<typeof updateBlurbInputSchema>;
