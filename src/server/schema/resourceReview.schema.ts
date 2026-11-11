import * as z from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';
import type { santizeHtmlOptions } from '~/utils/html-sanitize-helpers';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';
import { numericString } from '~/utils/zod-helpers';

export function sanitizedNullableString(options: santizeHtmlOptions) {
  return z
    .string()
    .transform((val, ctx) => {
      try {
        if (!val) return;
        const result = sanitizeHtml(val, options);
        if (result.length === 0) return null;
        return result;
      } catch (e) {
        ctx.addIssue({
          code: 'custom',
          message: (e as any).message,
        });
      }
    })
    .nullish();
}

export type GetUserResourceReviewInput = z.infer<typeof getUserResourceReviewSchema>;
export const getUserResourceReviewSchema = z.object({
  modelId: z.number().optional(),
  modelVersionId: z.number().optional(),
});

export type GetResourceReviewsInput = z.infer<typeof getResourceReviewsSchema>;
export const getResourceReviewsSchema = z.object({
  resourceIds: z.number().array(),
});

export type GetRatingTotalsInput = z.infer<typeof getRatingTotalsSchema>;
export const getRatingTotalsSchema = z.object({
  modelVersionId: z.number().optional(),
  modelId: z.number(),
});

export type GetResourceReviewsInfiniteInput = z.infer<typeof getResourceReviewsInfiniteSchema>;
export const getResourceReviewsInfiniteSchema = z.object({
  limit: z.number().min(1).max(100).default(50),
  cursor: z.number().optional(),
  modelId: z.number().optional(),
  modelVersionId: z.number().optional(),
  username: z.string().optional(),
  include: z.array(z.enum(['model'])).optional(),
  hasDetails: z.boolean().optional(),
});

export type UpsertResourceReviewInput = z.infer<typeof upsertResourceReviewSchema>;
export const upsertResourceReviewSchema = z.object({
  id: z.number().optional(),
  /** The post the review is written from. Read on create only. */
  postId: z.number().optional(),
  modelId: z.number(),
  modelVersionId: z.number(),
  rating: z.number(),
  recommended: z.boolean(),
  details: sanitizedNullableString({
    allowedTags: ['div', 'strong', 'p', 'em', 'u', 's', 'a', 'br', 'span', 'code', 'pre'],
    stripEmpty: true,
  }),
});

export type CreateResourceReviewInput = z.infer<typeof createResourceReviewSchema>;
export const createResourceReviewSchema = z.object({
  modelId: z.number(),
  modelVersionId: z.number(),
  rating: z.number(),
  recommended: z.boolean(),
  details: sanitizedNullableString({
    allowedTags: ['div', 'strong', 'p', 'em', 'u', 's', 'a', 'br', 'span', 'code', 'pre'],
    stripEmpty: true,
  }),
});

export type UpdateResourceReviewInput = z.infer<typeof updateResourceReviewSchema>;
export const updateResourceReviewSchema = z.object({
  id: z.number(),
  rating: z.number().optional(),
  recommended: z.boolean().optional(),
  details: sanitizedNullableString({
    allowedTags: ['div', 'strong', 'p', 'em', 'u', 's', 'a', 'br', 'span', 'code', 'pre'],
    stripEmpty: true,
  }),
});

const REVIEW_PAGE_SIZE_MAX = 50;

export type GetResourceReviewPagedInput = z.infer<typeof getResourceReviewPagedSchema>;
export const getResourceReviewPagedSchema = paginationSchema
  .extend({
    limit: z.coerce
      .number()
      .min(1)
      .default(20)
      .transform((limit) => Math.min(limit, REVIEW_PAGE_SIZE_MAX)),
    modelId: numericString(),
    modelVersionId: numericString().optional(),
    username: z.string().optional(),
    writtenOnly: z.boolean().optional(),
    hasImages: z.boolean().optional(),
    recommended: z.boolean().optional(),
  })
  // Without a version, writtenOnly regex-filters every review of the model before the first match.
  .refine((input) => !input.writtenOnly || input.modelVersionId, {
    message: 'writtenOnly requires modelVersionId',
    path: ['writtenOnly'],
  });

/** A review's image count stops at this; the list returns one more to mean "more than this". */
export const REVIEW_IMAGE_COUNT_CAP = 100;

/** With `hasImages`, the total stops counting at one more than this, so "1000+" is all a deep list can claim. */
export const REVIEW_HAS_IMAGES_COUNT_CAP = 1000;
