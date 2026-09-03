/**
 * Fixture for `no-throwing-image-query-parse`. Not real code and never imported by
 * the app — it exists so the guard can prove its matcher still matches before it is
 * allowed to report the tree clean.
 *
 * Every shape here is one a person would call the same defect. The multi-line ones
 * are the important ones: prettier BREAKS this call at the repo's line width, and
 * the modal's real call already spans several lines, so a line-by-line matcher goes
 * blind on the exact file whose chained form the guard was widened to catch.
 *
 * 🔴 The `prettier-ignore` comments are load-bearing, not cosmetic. Without them
 * `prettier --write` collapses both wrapped declarations onto one line and silently
 * deletes the only coverage of the multi-line case — measured, it did exactly that
 * on the first version of this file. The guard's expectations then fail loudly
 * rather than quietly, but the coverage would be gone either way. Leave them.
 *
 * `safeParse` at the bottom is the negative: it must never be reported, or the guard
 * would flag the very helper it tells people to use.
 */
import { imagesQueryParamSchema } from '~/components/Image/image.utils';

declare const query: Record<string, unknown>;

export const plain = imagesQueryParamSchema.parse(query);

export const chained = imagesQueryParamSchema.omit({ tags: true }).parse(query);

// prettier-ignore
export const wrappedChain = imagesQueryParamSchema
  .omit({ tags: true })
  .parse(query);

// prettier-ignore
export const wrappedPlain = imagesQueryParamSchema
  .parse(query);

export const asyncParse = imagesQueryParamSchema.parseAsync(query);

export const optionalChain = imagesQueryParamSchema?.parse(query);

// A commented violation, so that deleting stripComments is a FAILING change rather
// than a silent one: imagesQueryParamSchema.parse(query)
export const safe = imagesQueryParamSchema.safeParse(query);
