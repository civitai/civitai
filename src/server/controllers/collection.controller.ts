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
  UpdateCollectionCoverImageInput,
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
  updateCollectionCoverImage,
  getCollectionCoverImages,
  getCollectionItemCount,
  getContributorCount,
} from '~/server/services/collection.service';
import { TRPCError } from '@trpc/server';
import { GetByIdInput, UserPreferencesInput } from '~/server/schema/base.schema';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';
import { addPostImage, createPost } from '~/server/services/post.service';
import { CollectionItemStatus, CollectionReadConfiguration } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { imageSelect } from '~/server/selectors/image.selector';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { isDefined } from '~/utils/type-guards';
import { collectedContentReward } from '~/server/rewards';

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
        nsfwLevel: true,
        image: { select: imageSelect },
        mode: true,
      },
      user: ctx.user,
    });

    let nextCursor: number | undefined;
    if (items.length > input.limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    const { cursor, sort, privacy, types, userId, ids, ...userPreferences } = input;
    const collectionRequiringImages = items.filter((item) => !item.image).map((i) => i.id);
    const collectionImages = await getCollectionCoverImages({
      collectionIds: collectionRequiringImages,
      imagesPerCollection: 10, // Some fallbacks
    });

    // Get Item Counts
    const collectionIds = items.map((item) => item.id);
    const collectionItemCounts = Object.fromEntries(
      (
        await getCollectionItemCount({
          collectionIds,
          status: CollectionItemStatus.ACCEPTED,
        })
      ).map((c) => [c.id, Number(c.count)])
    );

    // Get Contributor Counts
    const contributorCounts = Object.fromEntries(
      (await getContributorCount({ collectionIds })).map((c) => [c.id, Number(c.count)])
    );

    return {
      nextCursor,
      items: items.map((item) => {
        const collectionImageItems = collectionImages.filter((ci) => ci.id === item.id);
        return {
          ...item,
          _count: {
            items: collectionItemCounts[item.id] ?? 0,
            contributors: contributorCounts[item.id] ?? 0,
          },
          image: item.image
            ? {
                ...item.image,
                meta: item.image.meta as ImageMetaProps | null,
                tags: item.image.tags.map((t) => t.tag),
              }
            : null,
          images: collectionImageItems.map((ci) => ci.image).filter(isDefined) ?? [],
          srcs: collectionImageItems.map((ci) => ci.src).filter(isDefined) ?? [],
        };
      }),
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
  ctx: Context;
  input: GetByIdInput;
}) => {
  const { user } = ctx;

  try {
    const permissions = await getUserCollectionPermissionsById({
      ...input,
      userId: user?.id,
      isModerator: user?.isModerator,
    });

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

export const saveItemHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: AddCollectionItemInput;
}) => {
  const { user } = ctx;
  try {
    const status = await saveItemInCollections({
      input: { ...input, userId: user.id, isModerator: user.isModerator },
    });

    if (status === 'added' && input.type) {
      const entityId = [input.articleId, input.modelId, input.postId, input.imageId].find(
        isDefined
      );

      if (entityId) {
        await collectedContentReward.apply(
          {
            collectorId: user.id,
            entityType: input.type,
            entityId,
          },
          ctx.ip
        );
      }
    }
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
  const { id: userId, isModerator } = ctx.user;
  try {
    const permissions = await getUserCollectionPermissionsById({
      id: input.collectionId,
      userId,
      isModerator,
    });

    return await bulkSaveItems({ input: { ...input, userId }, permissions });
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
    const collection = await upsertCollection({
      input: { ...input, userId: user.id, isModerator: user.isModerator },
    });

    return collection;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const updateCollectionCoverImageHandler = async ({
  input,
  ctx,
}: {
  input: UpdateCollectionCoverImageInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;

  try {
    const collection = await updateCollectionCoverImage({
      input: { ...input, userId: user.id, isModerator: user.isModerator },
    });

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
      input: { ...input, userId: user.id, isModerator: user.isModerator },
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
  // Safeguard against missing items that might be in collection but return null.
  // due to preferences and/or other statuses.
  const limit = 2 * input.limit;
  let collectionItems = await getCollectionItemsByCollectionId({
    input: { ...input, limit },
    user: ctx.user,
  });

  let nextCursor: number | undefined;

  if (collectionItems.length > input.limit) {
    const nextItem = collectionItems[input.limit + 1];
    nextCursor = nextItem?.id;
    collectionItems = collectionItems.slice(0, input.limit);
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
      input,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
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
    const { id: userId, isModerator } = ctx.user;
    const collection = await getCollectionById({ input: { id: collectionId } });
    if (!collection) throw throwNotFoundError(`No collection with id ${collectionId}`);

    const permissions = await getUserCollectionPermissionsById({
      id: collection.id,
      userId,
      isModerator,
    });
    if (!(permissions.write || permissions.writeReview))
      throw throwAuthorizationError('You do not have permission to add items to this collection.');

    // create post
    const post = await createPost({
      title: `${collection.name} Images`,
      userId,
      collectionId: collection.id,
      publishedAt: collection.read === CollectionReadConfiguration.Public ? new Date() : undefined,
    });
    const postImages = await Promise.all(
      images.map((image, index) =>
        addPostImage({
          ...image,
          postId: post.id,
          index,
          user: ctx.user,
        })
      )
    );
    const imageIds = postImages.map((image) => image.id);
    await bulkSaveItems({ input: { collectionId, imageIds, userId }, permissions });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
