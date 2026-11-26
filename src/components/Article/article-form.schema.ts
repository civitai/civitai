import * as z from 'zod';
import { articleContentSchema, upsertArticleInput } from '~/server/schema/article.schema';
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
    content: articleContentSchema,
  });

/**
 * With the banner field shown, either image will do: a banner-only article uses its banner on
 * cards. Without it, the cover is required, even when the article already has a banner.
 * `hasWithheldImage`: the article keeps a cover or banner this editor may not see, which a save
 * leaves in place, so none need be uploaded.
 */
export const articleFormSchema = (withBanner: boolean, hasWithheldImage = false) =>
  baseSchema.refine(
    (data) => hasWithheldImage || !!data.coverImage?.url || (withBanner && !!data.bannerImage?.url),
    {
      error: 'Please upload a cover image',
      path: ['coverImage'],
    }
  );
