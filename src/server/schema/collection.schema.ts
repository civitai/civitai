import { z } from 'zod';
import { isDefined } from '~/utils/type-guards';
import {
  CollectionContributorPermission,
  CollectionItemStatus,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
  CollectionWriteConfiguration,
} from '@prisma/client';
import { imageSchema } from '~/server/schema/image.schema';
import {
  baseQuerySchema,
  infiniteQuerySchema,
  userPreferencesSchema,
} from '~/server/schema/base.schema';
import { CollectionReviewSort, CollectionSort } from '~/server/common/enums';
import { constants } from '~/server/common/constants';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

// TODO.Fix: Type-safety. This isn't actually typesafe. You can choose a type and a id that don't match.
const collectionItemSchema = z.object({
  type: z.nativeEnum(CollectionType).optional(),
  articleId: z.number().optional(),
  postId: z.number().optional(),
  modelId: z.number().optional(),
  imageId: z.number().optional(),
  note: z.string().optional(),
});
export type CollectItemInput = z.infer<typeof collectionItemSchema>;

export type AddCollectionItemInput = z.infer<typeof saveCollectionItemInputSchema>;
export const saveCollectionItemInputSchema = collectionItemSchema
  .extend({
    collectionIds: z.coerce.number().array(),
    removeFromCollectionIds: z.coerce.number().array().optional(),
  })
  .refine(
    ({ articleId, imageId, postId, modelId }) =>
      [articleId, imageId, postId, modelId].filter(isDefined).length === 1,
    { message: 'Only one item can be added at a time.' }
  )
  .refine(
    ({ type, articleId, imageId, postId, modelId }) => {
      if (!type) {
        // Allows any type to be passed if type is not defined
        return true;
      }

      if (type === CollectionType.Article) {
        return articleId !== undefined;
      }
      if (type === CollectionType.Post) {
        return postId !== undefined;
      }
      if (type === CollectionType.Model) {
        return modelId !== undefined;
      }
      if (type === CollectionType.Image) {
        return imageId !== undefined;
      }
      return false;
    },
    { message: 'Please pass a valid item type.' }
  );

export type BulkSaveCollectionItemsInput = z.infer<typeof bulkSaveCollectionItemsInput>;
export const bulkSaveCollectionItemsInput = z
  .object({
    collectionId: z.coerce.number(),
    imageIds: z.coerce.number().array().optional(),
    articleIds: z.coerce.number().array().optional(),
    postIds: z.coerce.number().array().optional(),
    modelIds: z.coerce.number().array().optional(),
  })
  .refine(
    ({ articleIds, imageIds, postIds, modelIds }) =>
      [articleIds, imageIds, postIds, modelIds].filter(isDefined).length === 1,
    { message: 'Only one item can be added at a time.' }
  );

export type GetAllUserCollectionsInputSchema = z.infer<typeof getAllUserCollectionsInputSchema>;
export const getAllUserCollectionsInputSchema = z
  .object({
    contributingOnly: z.boolean().default(true),
    permission: z.nativeEnum(CollectionContributorPermission),
    permissions: z.array(z.nativeEnum(CollectionContributorPermission)),
    type: z.nativeEnum(CollectionType).optional(),
  })
  .partial();

export type CollectionMetadataSchema = z.infer<typeof collectionMetadataSchema>;
export const collectionMetadataSchema = z
  .object({
    endsAt: z.coerce.date().nullish(),
    maxItemsPerUser: z.coerce.number().optional(),
    submissionStartDate: z.coerce.date().nullish(),
    submissionEndDate: z.coerce.date().nullish(),
  })
  .refine(
    ({ submissionStartDate, submissionEndDate }) => {
      if (submissionStartDate && submissionEndDate) {
        return submissionStartDate < submissionEndDate;
      }

      return true;
    },
    {
      message: 'Submission start date must be before submission end date.',
      path: ['submissionStartDate'],
    }
  )
  .refine(
    ({ submissionStartDate, submissionEndDate }) => {
      if (submissionStartDate && submissionEndDate) {
        return true;
      }

      if (!submissionStartDate && !submissionEndDate) {
        return true;
      }

      return false;
    },
    { message: 'Either provide both submission values or none.', path: ['submissionStartDate'] }
  );

export type UpsertCollectionInput = z.infer<typeof upsertCollectionInput>;
export const upsertCollectionInput = z
  .object({
    id: z.number().optional(),
    name: z.string().max(30).nonempty(),
    description: z.string().max(300).nullish(),
    image: imageSchema.nullish(),
    imageId: z.number().optional(),
    nsfw: z.boolean().optional(),
    read: z.nativeEnum(CollectionReadConfiguration).optional(),
    write: z.nativeEnum(CollectionWriteConfiguration).optional(),
    type: z.nativeEnum(CollectionType).default(CollectionType.Model),
    mode: z.nativeEnum(CollectionMode).nullish(),
    metadata: collectionMetadataSchema.optional(),
  })
  .merge(collectionItemSchema);

export type UpdateCollectionCoverImageInput = z.infer<typeof updateCollectionCoverImageInput>;
export const updateCollectionCoverImageInput = z.object({
  id: z.number(),
  imageId: z.number(),
});

export type GetUserCollectionItemsByItemSchema = z.infer<typeof getUserCollectionItemsByItemSchema>;
export const getUserCollectionItemsByItemSchema = collectionItemSchema
  .extend({ note: z.never().optional() })
  .merge(getAllUserCollectionsInputSchema)
  .refine(
    ({ articleId, imageId, postId, modelId }) =>
      [articleId, imageId, postId, modelId].filter(isDefined).length === 1,
    { message: 'Please pass a single resource to match collections to.' }
  );

export type FollowCollectionInputSchema = z.infer<typeof followCollectionInputSchema>;

export const followCollectionInputSchema = z.object({
  collectionId: z.number(),
  userId: z.number().optional(),
});

export type GetAllCollectionItemsSchema = z.infer<typeof getAllCollectionItemsSchema>;
export const getAllCollectionItemsSchema = baseQuerySchema.extend({
  limit: z.number().min(0).max(100).optional(),
  page: z.number().optional(),
  cursor: z.number().optional(),
  collectionId: z.number(),
  statuses: z.array(z.nativeEnum(CollectionItemStatus)).optional(),
  forReview: z.boolean().optional(),
  reviewSort: z.nativeEnum(CollectionReviewSort).optional(),
});

export type UpdateCollectionItemsStatusInput = z.infer<typeof updateCollectionItemsStatusInput>;
export const updateCollectionItemsStatusInput = z.object({
  collectionId: z.number(),
  collectionItemIds: z.array(z.number()),
  status: z.nativeEnum(CollectionItemStatus),
});

export type AddSimpleImagePostInput = z.infer<typeof addSimpleImagePostInput>;
export const addSimpleImagePostInput = z.object({
  collectionId: z.number(),
  images: z.array(imageSchema).min(1, 'At least one image must be uploaded'),
});

export type GetAllCollectionsInfiniteSchema = z.infer<typeof getAllCollectionsInfiniteSchema>;
export const getAllCollectionsInfiniteSchema = infiniteQuerySchema
  .extend({
    userId: z.number(),
    types: z.array(z.nativeEnum(CollectionType)),
    privacy: z.array(z.nativeEnum(CollectionReadConfiguration)),
    sort: z.nativeEnum(CollectionSort).default(constants.collectionFilterDefaults.sort),
    ids: commaDelimitedNumberArray({ message: 'ids should be a number array' }),
  })
  .merge(userPreferencesSchema)
  .partial();
