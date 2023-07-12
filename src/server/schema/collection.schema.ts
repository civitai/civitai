import { z } from 'zod';
import { isDefined } from '~/utils/type-guards';
import { CollectionContributorPermission } from '@prisma/client';

export type AddCollectionItemInput = z.infer<typeof addCollectionItemInputSchema>;

export const addCollectionItemInputSchema = z
  .object({
    articleId: z.number().optional(),
    postId: z.number().optional(),
    modelId: z.number().optional(),
    imageId: z.number().optional(),
    collectionIds: z.number().array(),
    note: z.string().optional(),
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
