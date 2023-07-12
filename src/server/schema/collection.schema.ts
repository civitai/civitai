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

export type AddCollectionItemInput = z.infer<typeof addCollectionItemInputSchema>;
export const addCollectionItemInputSchema = collectionItemSchema
  .extend({
    collectionIds: z.number().array().min(1, 'Please select at least one collection'),
  })
  .refine(
    ({ articleId, imageId, postId, modelId }) =>
      [articleId, imageId, postId, modelId].filter(isDefined).length === 1,
    { message: 'Only one item can be added at a time.' }
  );

export type GetAllUserCollectionsInputSchema = z.infer<typeof getAllUserCollectionsInputSchema>;
export const getAllUserCollectionsInputSchema = z.object({
  permission: z.enum([
    CollectionContributorPermission.ADD,
    CollectionContributorPermission.VIEW,
    CollectionContributorPermission.MANAGE,
  ]),
});

export type UpsertCollectionInput = z.infer<typeof upsertCollectionInput>;
export const upsertCollectionInput = z
  .object({
    id: z.number().optional(),
    name: z.string().nonempty(),
    description: z.string().optional(),
    coverImage: z.string().optional(),
    read: z.nativeEnum(CollectionReadConfiguration).optional(),
    write: z.nativeEnum(CollectionWriteConfiguration).optional(),
  })
  .merge(collectionItemSchema);
