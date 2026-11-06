import { TRPCError } from '@trpc/server';
import { coverageAudience } from '~/server/services/generation/coverage-source';
import { constants } from '~/server/common/constants';
import type { Context, ProtectedContext } from '~/server/createContext';
import { logToAxiom } from '~/server/logging/client';
import { collectedContentReward } from '~/server/rewards';
import type { GetByIdInput, UserPreferencesInput } from '~/server/schema/base.schema';
import type {
  AddCollectionItemInput,
  AddSimpleImagePostInput,
  BulkSaveCollectionItemsInput,
  CollectionMetadataSchema,
  EnableCollectionYoutubeSupportInput,
  FollowCollectionInputSchema,
  GetAllCollectionItemsSchema,
  GetAllCollectionsInfiniteSchema,
  GetAllUserCollectionsInputSchema,
  GetCollectionPermissionDetails,
  GetUserCollectionItemsByItemSchema,
  RemoveCollectionItemInput,
  SetCollectionItemNsfwLevelInput,
  SetItemScoreInput,
  UpdateCollectionCoverImageInput,
  UpdateCollectionItemsStatusInput,
  UpsertCollectionInput,
} from '~/server/schema/collection.schema';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { imageSelect } from '~/server/selectors/image.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  addContributorToCollection,
  bulkSaveItems,
  checkUserOwnsCollectionAndItem,
  deleteCollectionById,
  getAllCollections,
  getCollectionById,
  getCollectionCoverImages,
  getCollectionItemById,
  getCollectionItemCount,
  getCollectionItemsByCollectionId,
  getContributorCount,
  getPendingCollectionReviewCounts,
  getPendingReviewCount,
  getUserCollectionItemsByItem,
  getUserCollectionPermissionsById,
  getUserCollectionPermissionsByIds,
  getUserCollectionsWithPermissions,
  removeCollectionItem,
  removeContributorFromCollection,
  saveItemInCollections,
  setCollectionItemNsfwLevel,
  setItemScore,
  updateCollectionCoverImage,
  updateCollectionItemsStatus,
  upsertCollection,
  validateContestCollectionEntry,
} from '~/server/services/collection.service';
import {
  getServableCoverCollectionIds,
  withServableCovers,
} from '~/server/services/collection-cover-visibility';
import { enableCollectionYoutubeSupport } from '~/server/services/collection-youtube.service';
import type { Collaborator } from '~/server/services/collection-collaborator.service';
import { getCollectionRoster } from '~/server/services/collection-collaborator.service';
import { setModelShowcaseCollection } from '~/server/services/model.service';
import { addPostImage, createPost, deletePost } from '~/server/services/post.service';
import { createPostOwnerCheck } from '~/server/services/image.service';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { requestServableLevels } from '~/server/utils/browsing-level';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { updateEntityMetric } from '~/server/utils/metric-helpers';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';
import {
  CollectionContributorPermission,
  CollectionItemStatus,
  CollectionMode,
  CollectionReadConfiguration,
} from '~/shared/utils/prisma/enums';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { isDefined } from '~/utils/type-guards';
import { dbRead } from '../db/client';

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
    const rows = await getAllCollections({
      input: { ...input, limit },
      select: {
        id: true,
        name: true,
        read: true,
        type: true,
        userId: true,
        user: { select: userWithCosmeticsSelect },
        nsfwLevel: true,
        image: { select: imageSelect },
        mode: true,
        createdAt: true,
        metadata: true,
      },
      user: ctx.user,
    });
    // A cover the viewer may not see falls through to the item covers below.
    const items = await withServableCovers(rows, ctx.user);

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
          metadata: (item.metadata ?? {}) as CollectionMetadataSchema,
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
  ctx: ProtectedContext;
  input: GetAllUserCollectionsInputSchema;
}) => {
  const { user } = ctx;

  try {
    // Concurrent, not serial: the permission query and the pending-review
    // aggregate hit independent backends and share only `user.id`. Both SSG
    // prefetches run this inside getServerSideProps, so a second round trip
    // lands straight on TTFB.
    const [collections, counts] = await Promise.all([
      getUserCollectionsWithPermissions({ input: { ...input, userId: user.id } }),
      input.withPendingReviewCounts
        ? getPendingCollectionReviewCounts({
            userId: user.id,
            levels: requestServableLevels(ctx),
          }).catch(() => ({
            total: 0,
            byCollection: {} as Record<number, number>,
          }))
        : undefined,
    ]);

    if (!counts) return collections;

    return collections.map((collection) => ({
      ...collection,
      pendingReviewCount: counts.byCollection[collection.id] ?? 0,
    }));
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
        collaborators: [] as Collaborator[],
        pendingReviewCount: 0,
        redPendingReviewCount: 0,
      };
    }

    const collection = await getCollectionById({ input, viewer: ctx.user });

    // The catch covers the roster read alone — the reads above must still surface — because
    // getById backs the whole detail page and every other useCollection consumer.
    const collaborators = permissions.read
      ? await getCollectionRoster(collection).catch((error) => {
          logToAxiom({
            type: 'error',
            name: 'collection-roster-failed',
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            collectionId: input.id,
          }).catch(() => undefined);
          return [] as Collaborator[];
        })
      : [];

    // What only civitai.red can show, for the empty .com queue to point at. Computed whether or not
    // the .com queue is empty now: reviewing its items leaves this number unchanged, so the cached
    // value is still right once the manager has cleared them. Not for a restricted region, where
    // civitai.red would hide the same items.
    const pointToRed = ctx.features.isGreen && !!ctx.req && !isRegionRestricted(getRegion(ctx.req));
    const [pendingReviewCount, allLevelsPendingReviewCount] = permissions.manage
      ? await Promise.all([
          getPendingReviewCount(collection.id, requestServableLevels(ctx)),
          pointToRed ? getPendingReviewCount(collection.id, allBrowsingLevelsFlag) : 0,
        ])
      : [0, 0];
    const redPendingReviewCount = pointToRed
      ? Math.max(0, allLevelsPendingReviewCount - pendingReviewCount)
      : 0;

    return {
      // Only an editor needs to know a cover is stored but hidden from them.
      collection: { ...collection, coverHidden: permissions.manage && collection.coverHidden },
      permissions,
      collaborators,
      pendingReviewCount,
      redPendingReviewCount,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const saveItemHandler = async ({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: AddCollectionItemInput;
}) => {
  const { user, ip } = ctx;
  try {
    const status = await saveItemInCollections({
      input: {
        ...input,
        userId: user.id,
        isModerator: user.isModerator,
        canAccessUserChallenges: ctx.features.userChallenges,
      },
    });

    if (status === 'added' && input.type) {
      const entityId = [input.articleId, input.modelId, input.postId, input.imageId].find(
        isDefined
      );

      if (entityId) {
        await collectedContentReward.apply(
          { collectorId: user.id, entityType: input.type, entityId },
          { ip }
        );
      }
    }

    // nb: this will count in review / rejected additions
    if (input.type === 'Image' && !!input.imageId) {
      await updateEntityMetric({
        ctx,
        entityType: 'Image',
        entityId: input.imageId,
        metricType: 'Collection',
        amount: status === 'added' ? 1 : -1,
      });
    }

    // Remove collection from model showcase if removed
    if (input.type === 'Model' && status === 'removed' && input.modelId) {
      // letting this run in the background to avoid blocking the response
      setModelShowcaseCollection({
        id: input.modelId,
        collectionId: null,
        userId: user.id,
        isModerator: user.isModerator,
      }).catch((error) =>
        logToAxiom({
          name: 'remove-model-showcase-collection',
          type: 'error',
          message: error.message,
        })
      );
    }

    // Check ownership if only one collection is being modified
    const [itemId] = [
      input.articleId,
      input.modelId,
      input.postId,
      input.imageId,
      input.model3dId,
    ].filter(isDefined);
    if (input.collections.length === 1) {
      const [collection] = input.collections;
      const isOwner = await checkUserOwnsCollectionAndItem({
        itemId,
        userId: user.id,
        collectionId: collection.collectionId,
      });
      return { status, isOwner };
    }

    return { status };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const bulkSaveItemsHandler = async ({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: BulkSaveCollectionItemsInput;
}) => {
  const { id: userId, isModerator } = ctx.user;
  try {
    const permissions = await getUserCollectionPermissionsById({
      id: input.collectionId,
      userId,
      isModerator,
    });

    if (!(permissions.write || permissions.writeReview))
      throw throwAuthorizationError('You do not have permission to add items to this collection.');

    const resp = await bulkSaveItems({
      input: {
        ...input,
        userId,
        isModerator,
        canAccessUserChallenges: ctx.features.userChallenges,
      },
      permissions,
    });

    for (const imgId of resp.imageIds) {
      await updateEntityMetric({
        ctx,
        entityType: 'Image',
        entityId: imgId,
        metricType: 'Collection',
        amount: 1,
      });
    }

    return { count: resp.count };
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
  ctx: ProtectedContext;
}) => {
  const { user } = ctx;

  try {
    const collection = await upsertCollection({
      input: {
        ...input,
        userId: user.id,
        isModerator: user.isModerator,
        isMember: !!user.tier && user.tier !== 'free',
      },
    });

    const [itemId] = [
      input.articleId,
      input.modelId,
      input.postId,
      input.imageId,
      input.model3dId,
    ].filter(isDefined);
    const isOwner = await checkUserOwnsCollectionAndItem({
      itemId,
      userId: user.id,
      collectionId: collection.id,
    });

    // The stored cover goes back by id only, and only when the caller may see it; its url is served
    // through the cover rule on read.
    const { image, ...rest } = collection;
    const coverVisible =
      !!image &&
      (
        await getServableCoverCollectionIds(
          [
            {
              collectionId: collection.id,
              collectionOwnerId: collection.userId,
              imageId: image.id,
            },
          ],
          user
        )
      ).has(collection.id);
    return { ...rest, image: coverVisible ? { id: image.id } : null, isOwner };
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
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
  input: FollowCollectionInputSchema;
}) => {
  const { user } = ctx;
  const { collectionId } = input;

  try {
    return addContributorToCollection({
      targetUserId: user.id,
      userId: user.id,
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
  ctx: ProtectedContext;
  input: FollowCollectionInputSchema;
}) => {
  const { user } = ctx;
  const { collectionId } = input;

  try {
    return removeContributorFromCollection({
      targetUserId: user.id,
      userId: user.id,
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
  const result = await getCollectionItemsByCollectionId({
    input,
    user: ctx.user,
    coverage: await coverageAudience(ctx.user ?? undefined),
  });

  return {
    nextCursor: result.nextCursor,
    collectionItems: result.items,
  };
};

export const updateCollectionItemsStatusHandler = async ({
  input,
  ctx,
}: {
  input: UpdateCollectionItemsStatusInput;
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
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

    // Entry-level refusals (ban, own/unavailable challenge, closed window) need no image ids, so
    // they fire before anything is created. Image-level ones are caught by the rollback below.
    if (collection.mode === CollectionMode.Contest) {
      await validateContestCollectionEntry({
        metadata: collection.metadata,
        collectionId: collection.id,
        userId,
        isModerator,
        canAccessUserChallenges: ctx.features.userChallenges,
        deferEntryFeeCharge: true,
      });
    }

    const post = await createPost({
      title: `${collection.name} Images`,
      userId,
      collectionId: collection.id,
      publishedAt: collection.read === CollectionReadConfiguration.Public ? new Date() : undefined,
    });

    // Everything that can refuse an entry without having charged anything runs inside this try.
    // Once bulkSaveItems starts, fee legs may be on the ledger (never refunded, keyed on the
    // image id), so from there the post and its images stay whatever happens.
    let imageIds: number[];
    try {
      // createImage's own primary-DB post-owner check runs once per request per post;
      // addPostImage keeps its existing per-image check.
      const assertPostOwnedBy = createPostOwnerCheck();
      // allSettled: a sibling still in flight must not land on the post after the rollback.
      const results = await Promise.allSettled(
        images.map((image, index) =>
          addPostImage({
            ...image,
            postId: post.id,
            index,
            user: ctx.user,
            assertPostOwnedBy,
          })
        )
      );
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (rejected) throw rejected.reason;
      imageIds = results.map((r) => (r as PromiseFulfilledResult<{ id: number }>).value.id);

      if (collection.mode === CollectionMode.Contest) {
        await validateContestCollectionEntry({
          metadata: collection.metadata,
          collectionId: collection.id,
          userId,
          isModerator,
          canAccessUserChallenges: ctx.features.userChallenges,
          imageIds,
          deferEntryFeeCharge: true,
        });
      }
    } catch (error) {
      // The refusal is what the user needs to see; a failed cleanup must not replace it.
      await deletePost({ id: post.id, isModerator }).catch((rollbackError) =>
        logToAxiom({
          type: 'error',
          name: 'add-simple-image-post-rollback-failed',
          message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          postId: post.id,
          collectionId,
        }).catch(() => undefined)
      );
      throw error;
    }

    await bulkSaveItems({
      input: {
        collectionId,
        imageIds,
        userId,
        isModerator,
        canAccessUserChallenges: ctx.features.userChallenges,
      },
      permissions,
    });

    return { post, permissions, imageIds };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const getPermissionDetailsHandler = async ({
  input: { ids },
  ctx,
}: {
  input: GetCollectionPermissionDetails;
  ctx: ProtectedContext;
}) => {
  if (ids.length === 0) return [];

  const collections = await dbRead.collection.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      name: true,
      metadata: true,
      mode: true,
      tags: {
        select: {
          filterableOnly: true,
          tag: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  });

  // Get permissions for each of these in a single query rather than one per collection.
  const permissions = await getUserCollectionPermissionsByIds({
    ids: collections.map((c) => c.id),
    userId: ctx.user.id,
    isModerator: ctx.user.isModerator,
  });
  const permissionsByCollectionId = new Map(permissions.map((p) => [p.collectionId, p]));

  return collections.flatMap((c) => {
    const permission = permissionsByCollectionId.get(c.id);
    if (!permission?.read) return [];

    return {
      ...c,
      tags: c.tags.map((t) => ({
        ...t.tag,
        filterableOnly: t.filterableOnly,
      })),
      metadata: (c.metadata ?? {}) as CollectionMetadataSchema,
      permissions: permission,
    };
  });
};

export const removeCollectionItemHandler = async ({
  input,
  ctx,
}: {
  input: RemoveCollectionItemInput;
  ctx: ProtectedContext;
}) => {
  const { user } = ctx;
  try {
    return await removeCollectionItem({
      ...input,
      userId: user.id,
      isModerator: user.isModerator,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const setItemScoreHandler = async ({
  input,
  ctx,
}: {
  input: SetItemScoreInput;
  ctx: ProtectedContext;
}) => {
  const { user } = ctx;
  try {
    const collectionItem = await getCollectionItemById({
      id: input.collectionItemId,
    });
    const permissions = await getUserCollectionPermissionsById({
      id: collectionItem.collectionId,
      userId: user.id,
      isModerator: user.isModerator,
    });

    if (!permissions.manage)
      throw throwAuthorizationError('You do not have permission to manage this collection.');

    return await setItemScore({ ...input, userId: user.id });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const setCollectionItemNsfwLevelHandler = async ({
  input,
  ctx,
}: {
  input: SetCollectionItemNsfwLevelInput;
  ctx: ProtectedContext;
}) => {
  const { user } = ctx;
  try {
    const collectionItem = await getCollectionItemById({
      id: input.collectionItemId,
    });

    const permissions = await getUserCollectionPermissionsById({
      id: collectionItem.collectionId,
      userId: user.id,
      isModerator: user.isModerator,
    });

    if (!permissions.manage)
      throw throwAuthorizationError('You do not have permission to manage this collection.');

    return await setCollectionItemNsfwLevel({ ...input });
  } catch (error) {
    throw throwDbError(error);
  }
};
export const enableCollectionYoutubeSupportHandler = async ({
  input,
  ctx,
}: {
  input: EnableCollectionYoutubeSupportInput;
  ctx: ProtectedContext;
}) => {
  const { user } = ctx;
  try {
    return await enableCollectionYoutubeSupport({ ...input, userId: user.id });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const joinCollectionAsManagerHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: ProtectedContext;
}) => {
  const collection = await getCollectionById({ input });
  if (!collection) {
    throw throwNotFoundError('Collection not found');
  }

  if (ctx.user.id === collection.userId) {
    return true;
  }

  if (!collection.metadata.inviteUrlEnabled) {
    throw throwAuthorizationError('You cannot join this collection via URL');
  }

  if (collection.mode !== CollectionMode.Contest) {
    throw throwAuthorizationError('This collection is not a contest');
  }

  await addContributorToCollection({
    targetUserId: ctx.user.id,
    // We'll do this as a system action on the meantime.
    // In the future, invites might be a thing.
    userId: collection.userId, // Collection owner
    collectionId: collection.id,
    permissions: [
      CollectionContributorPermission.ADD,
      CollectionContributorPermission.MANAGE,
      CollectionContributorPermission.VIEW,
    ],
  });

  return true;
};
