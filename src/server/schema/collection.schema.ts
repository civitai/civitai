import { z } from 'zod';
import { isDefined } from '~/utils/type-guards';
import {
  CollectionContributorPermission,
  CollectionReadConfiguration,
  CollectionWriteConfiguration,
} from '@prisma/client';

const collectionItemSchema = z.object({
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
  );

export type GetAllUserCollectionsInputSchema = z.infer<typeof getAllUserCollectionsInputSchema>;
export const getAllUserCollectionsInputSchema = z
  .object({
    contributingOnly: z.boolean().default(true),
    permission: z.nativeEnum(CollectionContributorPermission),
    permissions: z.array(z.nativeEnum(CollectionContributorPermission)),
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

export type GetUserCollectionsByItemSchema = z.infer<typeof getUserCollectionsByItemSchema>;
export const getUserCollectionsByItemSchema = collectionItemSchema
  .extend({ note: z.never().optional() })
  .merge(getAllUserCollectionsInputSchema)
  .refine(
    ({ articleId, imageId, postId, modelId }) =>
      [articleId, imageId, postId, modelId].filter(isDefined).length === 1,
    { message: 'Please pass a single resource to match collections to.' }
  );
