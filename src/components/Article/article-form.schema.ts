import * as z from 'zod';
import { upsertArticleInput } from '~/server/schema/article.schema';
import { imageSchema } from '~/server/schema/image.schema';

const baseSchema = upsertArticleInput
  .omit({
    coverImage: true,
    bannerImage: true,
    userNsfwLevel: true,
    moderatorNsfwLevel: true,
    lockedProperties: true,
  })
  .extend({
    categoryId: z.number().min(0, 'Please select a valid category'),
    coverImage: imageSchema.nullish(),
    bannerImage: imageSchema.nullish(),
    userNsfwLevel: z.string().optional(),
    moderatorNsfwLevel: z.string().optional(),
    lockedProperties: z.string().array().optional(),
  });

/**
 * With the banner field shown, either image will do: a banner-only article uses its banner on
 * cards. Without it, the cover is required, even when the article already has a banner.
 */
export const articleFormSchema = (withBanner: boolean) =>
  baseSchema.refine((data) => !!data.coverImage?.url || (withBanner && !!data.bannerImage?.url), {
    error: 'Please upload a cover image',
    path: ['coverImage'],
  });
