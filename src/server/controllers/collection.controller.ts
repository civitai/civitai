import { Context } from '~/server/createContext';
import { throwDbError } from '~/server/utils/errorHandling';
import {
  AddCollectionItemInput,
  GetAllUserCollectionsInputSchema,
  GetUserCollectionsByItemSchema,
  UpsertCollectionInput,
} from '~/server/schema/collection.schema';
import {
  saveItemInCollections,
  getUserCollectionsWithPermissions,
  upsertCollection,
  getUserCollectionsByItem,
  deleteCollectionById,
} from '~/server/services/collection.service';
import { TRPCError } from '@trpc/server';
import { GetByIdInput } from '~/server/schema/base.schema';
import { deletePost } from '~/server/services/post.service';

export const getAllUserCollectionsHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetAllUserCollectionsInputSchema;
}) => {
  const { user } = ctx;
  const { permission } = input;

  try {
    const collections = await getUserCollectionsWithPermissions({
      user,
      permissions: permission ? [permission] : [],
      select: {
        id: true,
        name: true,
        description: true,
        coverImage: true,
        read: true,
        items: { select: { modelId: true, imageId: true, articleId: true, postId: true } },
      },
    });

    return collections;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const saveItemHandler = ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: AddCollectionItemInput;
}) => {
  const { user } = ctx;

  try {
    return saveItemInCollections({ user, input });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertCollectionHandler = async ({
  input,
  ctx,
}: {
  input: UpsertCollectionInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;

  try {
    const collection = await upsertCollection({ input, user });

    return collection;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getUserCollectionsByItemHandler = async ({
  input,
  ctx,
}: {
  input: GetUserCollectionsByItemSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;

  try {
    const collections = await getUserCollectionsByItem({ input, user });

    return collections;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteUserCollectionHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { user } = ctx;
    await deleteCollectionById({ id: input.id, user });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
