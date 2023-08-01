import { Context } from '~/server/createContext';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  BulkSaveCollectionItemsInput,
  AddCollectionItemInput,
  FollowCollectionInputSchema,
  GetAllCollectionItemsSchema,
  GetAllUserCollectionsInputSchema,
  GetUserCollectionItemsByItemSchema,
  UpdateCollectionItemsStatusInput,
  UpsertCollectionInput,
  AddSimpleImagePostInput,
  GetAllCollectionsInfiniteSchema,
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
  bulkSaveItems,
  getAllCollections,
  CollectionItemExpanded,
} from '~/server/services/collection.service';
import { TRPCError } from '@trpc/server';
import { GetByIdInput, UserPreferencesInput } from '~/server/schema/base.schema';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';
import { addPostImage, createPost } from '~/server/services/post.service';
import { CollectionItemStatus, CollectionReadConfiguration } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { imageSelect } from '~/server/selectors/image.selector';
import { ImageMetaProps } from '~/server/schema/image.schema';

export const getAllCollectionsInfiniteHandler = async ({
  input,
  ctx,
}: {
  input: GetAllCollectionsInfiniteSchema;
  ctx: Context;
}) => {
  input.limit = input.limit ?? constants.collectionFilterDefaults.limit;
  const limit = input.limit + 1;

  try {
    const items = await getAllCollections({
      input: { ...input, limit },
      select: {
        id: true,
        name: true,
        read: true,
        type: true,
        userId: true,
        image: { select: imageSelect },
        _count: {
          select: {
            items: { where: { status: CollectionItemStatus.ACCEPTED } },
            contributors: true,
          },
        },
      },
      user: ctx.user,
    });

    let nextCursor: number | undefined;
    if (items.length > input.limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    const { cursor, sort, privacy, types, userId, ids, ...userPreferences } = input;
    const collectionsWithItems = await Promise.all(
      items.map(async (collection) => ({
        ...collection,
        items: !collection.image
          ? await getCollectionItemsByCollectionId({
              user: ctx.user,
              input: {
                ...userPreferences,
                collectionId: collection.id,
                limit: 4, // TODO.collections: only bring max four items per collection atm
              },
            })
          : ([] as CollectionItemExpanded[]),
      }))
    );

    return {
      nextCursor,
      items: collectionsWithItems.map((item) => ({
        ...item,
        image: item.image
          ? { ...item.image, meta: item.image.meta as ImageMetaProps | null }
          : undefined,
      })),
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

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
      input: {
        ...input,
        userId: user.id,
      },
      select: {
        id: true,
        name: true,
        description: true,
        image: true,
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
    const permissions = await getUserCollectionPermissionsById({ userId: user?.id, ...input });

    // If the user has 0 permission over this collection, they have no business asking for it.
    if (!permissions.read && !permissions.write && !permissions.manage) {
      return {
        collection: null,
        permissions,
      };
    }

    const collection = await getCollectionById({ input });

    return { collection, permissions };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
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
    return saveItemInCollections({ input: { ...input, userId: user.id } });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const bulkSaveItemsHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: BulkSaveCollectionItemsInput;
}) => {
  const { user } = ctx;
  try {
    const permissions = await getUserCollectionPermissionsById({
      id: input.collectionId,
      userId: user?.id,
    });

    return await bulkSaveItems({ input: { ...input, userId: user.id }, permissions });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
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
    const collection = await upsertCollection({ input: { ...input, userId: user.id } });

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
    const collectionItems = await getUserCollectionItemsByItem({
      input: { ...input, userId: user.id },
    });
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
    await deleteCollectionById({ id: input.id, userId: user.id, isModerator: user.isModerator });
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
    return addContributorToCollection({
      targetUserId: input.userId || user?.id,
      userId: user?.id,
      collectionId,
    });
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
    return removeContributorFromCollection({
      targetUserId: input.userId || user?.id,
      userId: user?.id,
      collectionId,
    });
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
    user: ctx.user,
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
      input: {
        ...input,
        userId: ctx.user.id,
      },
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const addSimpleImagePostHandler = async ({
  input: { collectionId, images },
  ctx,
}: {
  input: AddSimpleImagePostInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { user } = ctx;
    const collection = await getCollectionById({ input: { id: collectionId } });
    if (!collection) throw throwNotFoundError(`No collection with id ${collectionId}`);

    const permissions = await getUserCollectionPermissionsById({
      id: collection.id,
      userId: user?.id,
    });
    if (!(permissions.write || permissions.writeReview))
      throw throwAuthorizationError('You do not have permission to add items to this collection.');

    // create post
    const post = await createPost({
      title: `${collection.name} Images`,
      userId: user.id,
      collectionId: collection.id,
      publishedAt: collection.read === CollectionReadConfiguration.Public ? new Date() : undefined,
    });
    const postImages = await Promise.all(
      images.map((image, index) =>
        addPostImage({ ...image, postId: post.id, userId: user.id, index })
      )
    );
    const imageIds = postImages.map((image) => image.id);
    await bulkSaveItems({ input: { collectionId, imageIds, userId: user?.id }, permissions });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
