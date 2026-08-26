import * as z from 'zod';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { BLURB_INTERIOR_SANITIZE_OPTIONS } from '~/utils/html-sanitize-helpers';

// A snippet is a footer or a settings block, not an article. The cap is what stops one
// snippet's text becoming a large multiple of itself across every entity using it.
export const MAX_BLURB_LENGTH = 3000;

// A blurb is spliced into a `<div data-type="blurb">` of its own, so headings, lists and
// paragraphs survive here. What may not appear is on BLURB_INTERIOR_ALLOWED_TAGS, and this is one
// of the three places that allowlist has to hold — `blurb.create` is reachable with no toolbar in
// the way, and paste is its own path.
const blurbContentSchema = getSanitizedStringSchema(BLURB_INTERIOR_SANITIZE_OPTIONS).refine(
  (v) => v.length <= MAX_BLURB_LENGTH,
  `Snippets are limited to ${MAX_BLURB_LENGTH} characters.`
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
