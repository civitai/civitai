/**
 * Fixture for `no-throwing-image-query-parse`. Not real code and never imported by
 * the app — it exists so the guard can prove its matcher still matches before it is
 * allowed to report the tree clean.
 *
 * Keep both shapes: the plain call and the `.omit(...)`-chained one. The modal used
 * the chained form, so a matcher that only caught the plain form would have reported
 * clean while the bug it exists to catch was live.
 */
import { imagesQueryParamSchema } from '~/components/Image/image.utils';

declare const query: Record<string, unknown>;

export const plain = imagesQueryParamSchema.parse(query);
export const chained = imagesQueryParamSchema.omit({ tags: true }).parse(query);
