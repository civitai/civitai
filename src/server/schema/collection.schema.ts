import * as z from 'zod';
import { constants } from '~/server/common/constants';
import { CollectionReviewSort, CollectionSort } from '~/server/common/enums';
import {
  baseQuerySchema,
  infiniteQuerySchema,
  userPreferencesSchema,
} from '~/server/schema/base.schema';
import { imageSchema } from '~/server/schema/image.schema';
import { tagSchema } from '~/server/schema/tag.schema';
import {
  CollectionContributorPermission,
  CollectionItemStatus,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
  CollectionWriteConfiguration,
} from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';
import { NsfwLevel } from './../common/enums';

// TODO.Fix: Type-safety. This isn't actually typesafe. You can choose a type and a id that don't match.
const collectionItemSchema = z.object({
  type: z.enum(CollectionType).optional(),
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
    collections: z.array(
      z.object({
        collectionId: z.number(),
        tagId: z.number().nullish(),
        userId: z.number().nullish(),
        read: z.enum(CollectionReadConfiguration).optional(),
      })
    ),
    removeFromCollectionIds: z.coerce.number().array().optional(),
  })
  .refine(
    ({ articleId, imageId, postId, modelId }) =>
      [articleId, imageId, postId, modelId].filter(isDefined).length === 1,
    { error: 'Only one item can be added at a time.' }
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
    { error: 'Please pass a valid item type.' }
  );

export type BulkSaveCollectionItemsInput = z.infer<typeof bulkSaveCollectionItemsInput>;
export const bulkSaveCollectionItemsInput = z
  .object({
    collectionId: z.coerce.number(),
    imageIds: z.coerce.number().array().optional(),
    articleIds: z.coerce.number().array().optional(),
    postIds: z.coerce.number().array().optional(),
    modelIds: z.coerce.number().array().optional(),
    tagId: z.coerce.number().nullish(),
  })
  .refine(
    ({ articleIds, imageIds, postIds, modelIds }) =>
      [articleIds, imageIds, postIds, modelIds].filter(isDefined).length === 1,
    { error: 'Only one item can be added at a time.' }
  );

export type GetAllUserCollectionsInputSchema = z.infer<typeof getAllUserCollectionsInputSchema>;
export const getAllUserCollectionsInputSchema = z
  .object({
    contributingOnly: z.boolean().default(true),
    permission: z.enum(CollectionContributorPermission),
    permissions: z.array(z.enum(CollectionContributorPermission)),
    type: z.enum(CollectionType).optional(),
  })
  .partial();

export type CollectionMetadataSchema = z.infer<typeof collectionMetadataSchema>;
export const collectionMetadataSchema = z
  .object({
    endsAt: z.coerce.date().nullish(),
    challengeDatate: z.coerce.date().nullish(),
    maxItemsPerUser: z.coerce.number().optional(),
    submissionStartDate: z.coerce.date().nullish(),
    submissionEndDate: z.coerce.date().nullish(),
    submissionsHiddenUntilEndDate: z.boolean().optional(),
    existingEntriesDisabled: z.coerce.boolean().optional(),
    votingPeriodStart: z.coerce.date().nullish(),
    uploadSettings: z
      .object({
        maxItems: z.number(),
        maxSize: z.number(),
        maxVideoDuration: z.number(),
        maxVideoDimensions: z.number(),
      })
      .optional(),
    bannerPosition: z.string().optional(),
    judgesApplyBrowsingLevel: z.boolean().optional(),
    judgesCanScoreEntries: z.boolean().optional(),
    disableFollowOnSubmission: z.boolean().optional(),
    disableTagRequired: z.boolean().optional(),
    youtubeSupportEnabled: z.boolean().optional(),
    vimeoSupportEnabled: z.boolean().optional(),
    forcedBrowsingLevel: z.number().optional(),
    entriesRequireTitle: z.boolean().optional(),
    entriesRequireTools: z.boolean().optional(),
    termsOfServicesUrl: z.string().optional(),
    rulesUrl: z.string().optional(),
    hideAds: z.boolean().optional(),
    includeContestCallouts: z.boolean().optional(),
    // Invite URL will make it so that users with the URL can join the collection as managers / admins.
    inviteUrlEnabled: z.boolean().optional(),
  })
  .refine(
    ({ submissionStartDate, submissionEndDate }) => {
      if (submissionStartDate && submissionEndDate) {
        return submissionStartDate < submissionEndDate;
      }

      return true;
    },
    {
      error: 'Submission start date must be before submission end date.',
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
    { error: 'Either provide both submission values or none.', path: ['submissionStartDate'] }
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
    read: z.enum(CollectionReadConfiguration).optional(),
    write: z.enum(CollectionWriteConfiguration).optional(),
    type: z.enum(CollectionType).default(CollectionType.Model),
    mode: z.enum(CollectionMode).nullish(),
    metadata: collectionMetadataSchema.optional(),
    tags: z.array(tagSchema).nullish(),
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
    { error: 'Please pass a single resource to match collections to.' }
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
  cursor: z.string().optional(), // Format: "seed:sortKey:id" for random sort, or just "id" for other sorts
  collectionId: z.number(),
  statuses: z.array(z.enum(CollectionItemStatus)).optional(),
  forReview: z.boolean().optional(),
  reviewSort: z.enum(CollectionReviewSort).optional(),
  collectionTagId: z.number().optional(),
});

export type UpdateCollectionItemsStatusInput = z.infer<typeof updateCollectionItemsStatusInput>;
export const updateCollectionItemsStatusInput = z.object({
  collectionId: z.number(),
  collectionItemIds: z.array(z.number()),
  status: z.enum(CollectionItemStatus),
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
    types: z.array(z.enum(CollectionType)),
    privacy: z.array(z.enum(CollectionReadConfiguration)),
    sort: z.enum(CollectionSort).default(constants.collectionFilterDefaults.sort),
    ids: commaDelimitedNumberArray(),
    modes: z.array(z.enum(CollectionMode)),
  })
  .merge(userPreferencesSchema)
  .partial();

export type GetCollectionPermissionDetails = z.infer<typeof getCollectionPermissionDetails>;
export const getCollectionPermissionDetails = z.object({
  ids: z.array(z.number()).min(1),
});

export type RemoveCollectionItemInput = z.infer<typeof removeCollectionItemInput>;
export const removeCollectionItemInput = z.object({
  collectionId: z.coerce.number(),
  itemId: z.coerce.number(),
});

export type SetItemScoreInput = z.infer<typeof setItemScoreInput>;
export const setItemScoreInput = z.object({
  collectionItemId: z.coerce.number(),
  score: z.coerce.number().min(1).max(10),
});

export type SetCollectionItemNsfwLevelInput = z.infer<typeof setCollectionItemNsfwLevelInput>;
export const setCollectionItemNsfwLevelInput = z.object({
  collectionItemId: z.number(),
  nsfwLevel: z.enum(NsfwLevel),
});

export type EnableCollectionYoutubeSupportInput = z.infer<
  typeof enableCollectionYoutubeSupportInput
>;
export const enableCollectionYoutubeSupportInput = z.object({
  collectionId: z.number(),
  authenticationCode: z.string(),
});
