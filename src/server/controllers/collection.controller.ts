import { Context } from '~/server/createContext';
import { throwDbError } from '~/server/utils/errorHandling';
import {
  AddCollectionItemInput,
  FollowCollectionInputSchema,
  GetAllCollectionItemsSchema,
  GetAllUserCollectionsInputSchema,
  GetUserCollectionItemsByItemSchema,
  UpdateCollectionItemsStatusInput,
  UpsertCollectionInput,
} from '~/server/schema/collection.schema';
import {
  saveItemInCollections,
  getUserCollectionsWithPermissions,
  upsertCollection,
  deleteCollectionById,
  getUserCollectionPermissionsById,
  getCollectionById,
  addContributorToCollection,
  removeContributorFromCollection,
  getUserCollectionItemsByItem,
  getCollectionItemsByCollectionId,
  updateCollectionItemsStatus,
} from '~/server/services/collection.service';
import { TRPCError } from '@trpc/server';
import { GetByIdInput } from '~/server/schema/base.schema';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';
import { UserPreferencesInput } from '~/server/middleware.trpc';

export const getAllUserCollectionsHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetAllUserCollectionsInputSchema;
}) => {
  const { user } = ctx;

  try {
    const collections = await getUserCollectionsWithPermissions({
      input,
      user,
      select: {
        id: true,
        name: true,
        description: true,
        coverImage: true,
        read: true,
        items: { select: { modelId: true, imageId: true, articleId: true, postId: true } },
        userId: true,
      },
    });

    return collections;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getCollectionByIdHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetByIdInput;
}) => {
  const { user } = ctx;

  try {
    const permissions = await getUserCollectionPermissionsById({ user, ...input });

    // If the user has 0 permission over this collection, they have no business asking for it.
    if (!permissions.read && !permissions.write && !permissions.manage) {
      return {
        collection: null,
        permissions,
      };
    }

    const collection = await getCollectionById({ input });

    return {
      collection,
      permissions,
    };
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

export const getUserCollectionItemsByItemHandler = async ({
  input,
  ctx,
}: {
  input: GetUserCollectionItemsByItemSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;

  try {
    const collectionItems = await getUserCollectionItemsByItem({ input, user });
    return collectionItems;
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

export const followHandler = ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: FollowCollectionInputSchema;
}) => {
  const { user } = ctx;
  const { collectionId } = input;

  try {
    return addContributorToCollection({ user, userId: user?.id, collectionId });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const unfollowHandler = ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: FollowCollectionInputSchema;
}) => {
  const { user } = ctx;
  const { collectionId } = input;

  try {
    return removeContributorFromCollection({ user, userId: user.id, collectionId });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const collectionItemsInfiniteHandler = async ({
  input,
  ctx,
}: {
  input: GetAllCollectionItemsSchema & UserPreferencesInput;
  ctx: Context;
}) => {
  input.limit = input.limit ?? DEFAULT_PAGE_SIZE;
  const limit = input.limit + 1;
  const collectionItems = await getCollectionItemsByCollectionId({
    input: { ...input, limit },
    ctx,
  });

  let nextCursor: number | undefined;

  if (collectionItems.length > input.limit) {
    const nextItem = collectionItems.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    collectionItems,
  };
};

export const updateCollectionItemsStatusHandler = async ({
  input,
  ctx,
}: {
  input: UpdateCollectionItemsStatusInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return updateCollectionItemsStatus({
      user: ctx.user,
      input,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};
