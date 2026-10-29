import * as z from 'zod';
import { ImageSort } from '~/server/common/enums';
import { baseModels } from '~/shared/constants/basemodel.constants';
import { jumpToMonthParam } from '~/shared/utils/jump-to-month';
import { MediaType, MetricTimeframe, ReviewReactions } from '~/shared/utils/prisma/enums';
import { postgresSlugify } from '~/utils/string-helpers';
import { booleanString, numericString, numericStringArray } from '~/utils/zod-helpers';

// React-free so a server module can read a page's query exactly as the page does.

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
 * Never a bare `.parse`: one junk param (e.g. `?postId=null`, from stale shared/emailed links)
 * makes the schema throw and the page 500s. All-or-nothing: one junk key discards the valid ones
 * beside it.
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
