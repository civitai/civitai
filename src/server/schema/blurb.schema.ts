import * as z from 'zod';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { BLURB_INTERIOR_SANITIZE_OPTIONS, getBlurbText } from '~/utils/html-sanitize-helpers';

// A snippet is a footer or a settings block, not an article. The cap is what stops one
// snippet's text becoming a large multiple of itself across every entity using it. It counts
// visible text only, matching the editor's counter, so paragraph markup never eats the budget.
export const MAX_BLURB_LENGTH = 3000;
// Bounds the markup the text cap ignores, since it is copied into every host entity too. The
// editor cannot realistically reach it, so creators never see it.
export const MAX_BLURB_HTML_LENGTH = MAX_BLURB_LENGTH * 5;

// A blurb is spliced into a `<div data-type="blurb">` of its own, so headings, lists and
// paragraphs survive here. What may not appear is on BLURB_INTERIOR_ALLOWED_TAGS, and this is one
// of the three places that allowlist has to hold — `blurb.create` is reachable with no toolbar in
// the way, and paste is its own path. Empty elements are dropped at save only, so the splice and
// render paths keep the shared options unchanged. An inline element holding only a space is the
// space between two words, so only blocks are dropped for whitespace.
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'li']);
const blurbContentSchema = getSanitizedStringSchema({
  ...BLURB_INTERIOR_SANITIZE_OPTIONS,
  nestingLimit: 20,
  exclusiveFilter: (frame) =>
    frame.tag !== 'br' && (BLOCK_TAGS.has(frame.tag) ? !frame.text.trim() : !frame.text),
})
  .refine((v) => getBlurbText(v).trim().length > 0, 'Snippet cannot be empty.')
  .refine(
    (v) => getBlurbText(v).length <= MAX_BLURB_LENGTH,
    `Snippets are limited to ${MAX_BLURB_LENGTH} characters.`
  )
  .refine((v) => v.length <= MAX_BLURB_HTML_LENGTH, 'Snippet formatting is too large.');

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
