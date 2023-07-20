import { z } from 'zod';
import { isDefined } from '~/utils/type-guards';
import {
  CollectionContributorPermission,
  CollectionReadConfiguration,
  CollectionType,
  CollectionWriteConfiguration,
} from '@prisma/client';

const collectionItemSchema = z.object({
  type: z.nativeEnum(CollectionType).optional(),
  articleId: z.number().optional(),
  postId: z.number().optional(),
  modelId: z.number().optional(),
  imageId: z.number().optional(),
  note: z.string().optional(),
});

export type AddCollectionItemInput = z.infer<typeof saveCollectionItemInputSchema>;
export const saveCollectionItemInputSchema = collectionItemSchema
  .extend({
    collectionIds: z.coerce.number().array(),
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

export type GetAllUserCollectionsInputSchema = z.infer<typeof getAllUserCollectionsInputSchema>;
export const getAllUserCollectionsInputSchema = z
  .object({
    contributingOnly: z.boolean().default(true),
    permission: z.nativeEnum(CollectionContributorPermission),
    permissions: z.array(z.nativeEnum(CollectionContributorPermission)),
    type: z.nativeEnum(CollectionType).optional(),
  })
  .partial();

export type UpsertCollectionInput = z.infer<typeof upsertCollectionInput>;
export const upsertCollectionInput = z
  .object({
    id: z.number().optional(),
    name: z.string().max(30).nonempty(),
    description: z.string().max(300).optional(),
    coverImage: z.string().optional(),
    read: z.nativeEnum(CollectionReadConfiguration).optional(),
    write: z.nativeEnum(CollectionWriteConfiguration).optional(),
  })
  .merge(collectionItemSchema);

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
});
