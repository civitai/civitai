import * as z from 'zod';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { BLURB_INTERIOR_SANITIZE_OPTIONS } from '~/utils/html-sanitize-helpers';

// A blurb is a footer or a settings block, not an article. The cap is what stops one
// blurb's text becoming a large multiple of itself across every entity using it.
export const MAX_BLURB_LENGTH = 3000;

// The blurb editor is a RichTextEditor, so `editor.getHTML()` wraps even one line in
// `<p>…</p>`. Block BOUNDARIES become `<br>` before the block tags are stripped below —
// without this the strip concatenates `<p>a</p><p>b</p>` into `ab`, silently running the
// author's words together.
//
// Every block tag, not just `p`: the toolbar no longer offers blockquote or code block, but
// `blurb.create` is reachable with no toolbar in the way and paste is its own path. A boundary
// this misses is a run-on with nothing to point at.
const BLOCK_TAGS = 'pre|p|blockquote|div|li|ul|ol|h1|h2|h3|h4|h5|h6';
const BLOCK_BOUNDARY = new RegExp(`</(?:${BLOCK_TAGS})>\\s*<(?:${BLOCK_TAGS})(?:\\s[^>]*)?>`, 'gi');
const blockBreaksToLineBreaks = (value: unknown) =>
  typeof value === 'string' ? value.replace(BLOCK_BOUNDARY, '<br />') : value;

// Inline tags only — see the 🔴 note on BLURB_INTERIOR_ALLOWED_TAGS. A block element stored
// here is spliced inside an inline `<span>` in someone's article body, where the HTML parser
// hoists it out and leaves the chip empty.
const blurbContentSchema = z
  .preprocess(blockBreaksToLineBreaks, getSanitizedStringSchema(BLURB_INTERIOR_SANITIZE_OPTIONS))
  .refine(
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
