import * as z from 'zod';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { BLURB_INTERIOR_SANITIZE_OPTIONS } from '~/utils/html-sanitize-helpers';

// A blurb is a footer or a settings block, not an article. The cap is what stops one
// blurb's text becoming a large multiple of itself across every entity using it.
export const MAX_BLURB_LENGTH = 3000;

// The blurb editor is a full RichTextEditor, so `editor.getHTML()` wraps even one line in
// `<p>…</p>`. Paragraph BOUNDARIES become `<br>` before the block tags are stripped below —
// without this the strip concatenates `<p>a</p><p>b</p>` into `ab`, silently running the
// author's words together.
const paragraphBreaksToLineBreaks = (value: unknown) =>
  typeof value === 'string' ? value.replace(/<\/p>\s*<p[^>]*>/gi, '<br />') : value;

// Inline tags only — see the 🔴 note on BLURB_INTERIOR_ALLOWED_TAGS. A block element stored
// here is spliced inside an inline `<span>` in someone's article body, where the HTML parser
// hoists it out and leaves the chip empty.
const blurbContentSchema = z
  .preprocess(
    paragraphBreaksToLineBreaks,
    getSanitizedStringSchema(BLURB_INTERIOR_SANITIZE_OPTIONS)
  )
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
