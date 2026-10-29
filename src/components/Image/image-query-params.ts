import * as z from 'zod';
import { ImageSort } from '~/server/common/enums';
import { baseModels } from '~/shared/constants/basemodel.constants';
import { jumpToMonthParam } from '~/shared/utils/jump-to-month';
import { MediaType, MetricTimeframe, ReviewReactions } from '~/shared/utils/prisma/enums';
import { postgresSlugify } from '~/utils/string-helpers';
import { booleanString, numericString, numericStringArray } from '~/utils/zod-helpers';

/**
 * The image feed's router-query schema and its non-throwing parse, React-free so a server module
 * (the image page's page-data endpoint) reads a page's query exactly as the page does. Moved out of
 * `image.utils`, which re-exports all of it.
 */

const imageSections = ['images', 'reactions'] as const;
export type ImageSections = (typeof imageSections)[number];

// output is input to getInfiniteImagesSchema
export type ImagesQueryParamSchema = z.infer<typeof imagesQueryParamSchema>;
export const imagesQueryParamSchema = z
  .object({
    baseModels: z
      .union([z.enum(baseModels).array(), z.enum(baseModels)])
      .transform((val) => (Array.isArray(val) ? val : [val]))
      .optional(),
    collectionId: numericString(),
    collectionTagId: numericString(),
    hubId: numericString(),
    hideAutoResources: booleanString(),
    hideManualResources: booleanString(),
    followed: booleanString(),
    newCreators: booleanString(),
    fromPlatform: booleanString(),
    hidden: booleanString(),
    includeBaseModel: booleanString(),
    jumpTo: jumpToMonthParam,
    limit: numericString(),
    modelId: numericString(),
    modelVersionId: numericString(),
    notPublished: booleanString(),
    publishedOnly: booleanString(),
    pendingReviewOnly: booleanString(),
    period: z.enum(MetricTimeframe),
    periodMode: z.enum(['stats', 'published']).optional(),
    postId: numericString(),
    prioritizedUserIds: numericStringArray(),
    reactions: z.preprocess(
      (val) => (Array.isArray(val) ? val : [val]),
      z.array(z.enum(ReviewReactions))
    ),
    scheduled: booleanString(),
    section: z.enum(imageSections),
    sort: z.enum(ImageSort),
    tags: numericStringArray(),
    techniques: numericStringArray(),
    tools: numericStringArray(),
    types: z
      .union([z.array(z.enum(MediaType)), z.enum(MediaType)])
      .transform((val) => (Array.isArray(val) ? val : [val]))
      .optional(),
    userId: numericString(),
    username: z.coerce.string().transform(postgresSlugify),
    view: z.enum(['categories', 'feed']),
    withMeta: booleanString().optional(),
    requiringMeta: booleanString(),
    remixOfId: numericString(),
    includePG13: booleanString().optional(),
    poiOnly: booleanString(),
    minorOnly: booleanString(),
    disablePoi: booleanString(),
    disableMinor: booleanString(),
    remixesOnly: booleanString(),
    nonRemixesOnly: booleanString(),
    hideChallenges: booleanString(),
  })
  .partial();

/**
 * Read `imagesQueryParamSchema` off a router query WITHOUT throwing.
 *
 * 🔴 This must never become a bare `.parse`. `postId` (and every other
 * `numericString` key) rejects anything `Number()` turns into NaN, so a single
 * junk param made the whole schema throw — and a throw in a page's render is a
 * 500, not a degraded page. `/images/[imageId]?postId=null` returned 500 on prod
 * for exactly that reason: the `image-reaction-milestone` notification
 * interpolated a null `postId` into the literal string `null`, and 25,135 images
 * on prod have a null `postId` (article covers, mainly).
 *
 * The emitter is fixed too, and that fix IS retroactive for in-app notifications:
 * the URL is not stored, it is recomputed at render by `getNotificationMessage`
 * from the stored `details` JSON, so old rows re-render with the corrected link.
 * The read side still has to survive junk on its own, because a URL already copied
 * out of the app — shared, bookmarked, crawled, or baked into an email by the
 * external notifications service — is beyond the emitter's reach, and because
 * `?postId=abc` from any source hits the same throw.
 *
 * Dropping the whole filter object is consistent with `useZodRouteParams`, which
 * has always done this same `safeParse`-then-`{}` over this same schema and query.
 * Note what that costs: zod object parsing is all-or-nothing, so one junk key
 * discards the valid ones beside it. That is a known coarse edge, not a claim that
 * per-key recovery would be wrong.
 *
 * The optional `schema` is for `ImageDetailModal`, which parses a variant
 * (`.omit({ tags: true })`) off the SAME `useBrowserRouter` query. `removeEmpty`
 * there drops null *values*, not the string `'null'`, so the junk reaches the
 * parse either way — the modal is the next thing a user touches after landing on
 * one of these links, and it threw for the same reason the page did.
 */
export function parseImageQueryParams(query: Record<string, unknown>): ImagesQueryParamSchema;
export function parseImageQueryParams<TSchema extends z.ZodObject>(
  query: Record<string, unknown>,
  schema: TSchema
): Partial<z.infer<TSchema>>;
export function parseImageQueryParams(
  query: Record<string, unknown>,
  schema: z.ZodObject = imagesQueryParamSchema
) {
  const result = schema.safeParse(query);
  return result.success ? result.data : {};
}

/**
 * Whether `/images/[imageId]` shows the image from the filtered feed (`image.getInfinite`) rather
 * than from `image.get`: true when the page's query carries any feed filter or a `postId`.
 * `ImageDetailProvider` decides `shouldFetchMany` with it; the page-data endpoint withholds the
 * main-image preload with it, since a feed row is not the `image.get` row the preload URL is built
 * from (the index path's rows carry no `name`, so their URL differs).
 */
export function hasImageDetailQueryFilters(filters: ImagesQueryParamSchema, postId?: number) {
  return Object.keys(filters).length > 0 || !!postId;
}
