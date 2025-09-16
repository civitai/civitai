import { TRPCError } from '@trpc/server';
import { v4 as uuid } from 'uuid';
import {
  BlockedReason,
  ImageSort,
  NotificationCategory,
  NsfwLevel,
  SearchIndexUpdateQueueAction,
} from '~/server/common/enums';
import type { Context } from '~/server/createContext';
import { dbRead, dbWrite } from '~/server/db/client';
import { reportAcceptedReward } from '~/server/rewards';
import type { GetByIdInput } from '~/server/schema/base.schema';
import { getUserCollectionPermissionsById } from '~/server/services/collection.service';
import {
  isImageInQueue,
  updatePendingImageRatings,
} from '~/server/services/games/new-order.service';
import {
  addBlockedImage,
  bulkRemoveBlockedImages,
  deleteImageById,
  getAllImagesIndex,
  getPostDetailByImageId,
  queueImageSearchIndexUpdate,
  setVideoThumbnail,
  updateImageAcceptableMinor,
  updateImageNsfwLevel,
  updateImageReportStatusByReason,
} from '~/server/services/image.service';
import { getGallerySettingsByModelId } from '~/server/services/model.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { createNotification } from '~/server/services/notification.service';
import { amIBlockedByUser } from '~/server/services/user.service';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getNsfwLevelDeprecatedReverseMapping } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import {
  BlockImageReason,
  NewOrderRankType,
  ReportReason,
  ReportStatus,
} from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';
import type {
  GetEntitiesCoverImage,
  GetImageInput,
  GetInfiniteImagesOutput,
  ImageModerationSchema,
  ImageReviewQueueInput,
  SetVideoThumbnailInput,
  UpdateImageAcceptableMinorInput,
  UpdateImageNsfwLevelOutput,
} from './../schema/image.schema';
import {
  getAllImages,
  getEntityCoverImage,
  getImage,
  getImageContestCollectionDetails,
  getImageModerationReviewQueue,
  getImageResources,
  getResourceIdsForImages,
  getTagNamesForImages,
  moderateImages,
} from './../services/image.service';
import { Limiter } from '~/server/utils/concurrency-helpers';

export const moderateImageHandler = async ({
  input,
  ctx,
}: {
  input: ImageModerationSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const images = await moderateImages({
      ...input,
      include: ['user-notification', 'phash-block'],
      moderatorId: ctx.user.id,
    });
    if (input.reviewAction === 'block') {
      const ids = images.map((x) => x.id);
      const imageTags = await getTagNamesForImages(ids);
      const imageResources = await getResourceIdsForImages(ids);
      await Limiter().process(images, (images) =>
        ctx.track.images(
          images.map(({ id, userId, nsfwLevel, needsReview }) => {
            const tosReason = needsReview ?? 'other';
            const tags = imageTags[id] ?? [];
            tags.push(tosReason);
            const resources = imageResources[id] ?? [];

            return {
              type: 'DeleteTOS',
              imageId: id,
              nsfw: getNsfwLevelDeprecatedReverseMapping(nsfwLevel),
              tags,
              resources,
              tosReason: tosReason,
              ownerId: userId,
            };
          })
        )
      );
    }
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const deleteImageHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const imageTags = await dbRead.imageTag.findMany({
      where: {
        imageId: input.id,
        concrete: true,
      },
      select: {
        tagName: true,
      },
    });

    const image = await deleteImageById(input);

    if (image) {
      await ctx.track.images([
        {
          type: 'Delete',
          imageId: input.id,
          nsfw: getNsfwLevelDeprecatedReverseMapping(image.nsfwLevel),
          tags: imageTags.map((x) => x.tagName),
          ownerId: image.userId,
        },
      ]);
    }

    return image;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const setTosViolationHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { user, ip, fingerprint } = ctx;
    const { id } = input;
    if (!user.isModerator) throw throwAuthorizationError('Only moderators can set TOS violation');

    // Get details of the image
    const image = await dbRead.image.findFirst({
      where: { id },
      select: {
        nsfwLevel: true,
        userId: true,
        postId: true,
        pHash: true,
        post: {
          select: {
            title: true,
          },
        },
      },
    });
    if (!image) throw throwNotFoundError(`No image with id ${id}`);

    // Update all reports with this comment id to actioned
    const affectedReports = await updateImageReportStatusByReason({
      id,
      reason: ReportReason.TOSViolation,
      status: ReportStatus.Actioned,
    });
    // Reward users for accepted reports
    for (const report of affectedReports) {
      reportAcceptedReward.apply(
        { userId: report.userId, reportId: report.id },
        { ip, fingerprint }
      );
    }

    await createNotification({
      userId: image.userId,
      type: 'tos-violation',
      category: NotificationCategory.System,
      key: `tos-violation:image:${uuid()}`,
      details: {
        modelName: image.post?.title ?? `post #${image.postId as number}`,
        entity: 'image',
        url: `/images/${id}`,
      },
    }).catch();

    // Block image
    // This used to be a delete, but the mod team prefers to have the clean up happen later
    await dbWrite.image.updateMany({
      where: { id },
      data: {
        needsReview: null,
        ingestion: 'Blocked',
        // nsfw: 'Blocked',
        nsfwLevel: NsfwLevel.Blocked,
        blockedFor: BlockedReason.Moderated,
        updatedAt: new Date(),
      },
    });

    if (image.pHash) await addBlockedImage({ hash: image.pHash, reason: BlockImageReason.TOS });
    await queueImageSearchIndexUpdate({ ids: [id], action: SearchIndexUpdateQueueAction.Delete });

    const imageTags = await getTagNamesForImages([id]);
    const imageResources = await getResourceIdsForImages([id]);
    await ctx.track.images([
      {
        type: 'DeleteTOS',
        imageId: id,
        nsfw: getNsfwLevelDeprecatedReverseMapping(image.nsfwLevel),
        tags: imageTags[id] ?? [],
        resources: imageResources[id] ?? [],
        tosReason: 'manual',
        ownerId: image.userId,
      },
    ]);
    return image;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

// #region [new handlers]
export const getInfiniteImagesHandler = async ({
  input,
  ctx,
}: {
  input: GetInfiniteImagesOutput;
  ctx: Context;
}) => {
  const { user, features } = ctx;
  const fetchFn = features.imageIndexFeed && input.useIndex ? getAllImagesIndex : getAllImages;
  // console.log(fetchFn === getAllImagesIndex ? 'Using search index for feed' : 'Using DB for feed');

  try {
    return await fetchFn({
      ...input,
      user,
      useCombinedNsfwLevel: !features.canViewNsfw,
      headers: { src: 'getInfiniteImagesHandler' },
      include: [...input.include, 'tagIds'],
      useLogicalReplica: features.logicalReplica,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

const getReactionTotals = (post: ImagesAsPostModel) => {
  const stats = post.images[0]?.stats;
  if (!stats) return 0;

  return (
    stats.likeCountAllTime +
    stats.laughCountAllTime +
    stats.heartCountAllTime +
    stats.cryCountAllTime -
    stats.dislikeCountAllTime
  );
};

export type ImagesAsPostModel = AsyncReturnType<typeof getImagesAsPostsInfiniteHandler>['items'][0];
type ImageResultSearchIndex = AsyncReturnType<typeof getAllImagesIndex>['items'][number];
type ImageResultDB = AsyncReturnType<typeof getAllImages>['items'][number];
export const getImagesAsPostsInfiniteHandler = async ({
  input: { limit, cursor, hidden, ...input },
  ctx,
}: {
  input: GetInfiniteImagesOutput;
  ctx: Context;
}) => {
  try {
    const { user, features } = ctx;
    const fetchFn = features.imageIndex ? getAllImagesIndex : getAllImages;
    // console.log(features.imageIndex ? 'Using search index' : 'Using DB');
    type ResultType = typeof features.imageIndex extends true
      ? ImageResultSearchIndex
      : ImageResultDB;

    const posts: Record<number, ResultType[]> = {};
    const pinned: Record<number, ResultType[]> = {};
    let remaining = limit;
    const fetchHidden = hidden && input.modelId;
    const modelGallerySettings = input.modelId
      ? await getGallerySettingsByModelId({ id: input.modelId })
      : null;
    const hiddenImages = modelGallerySettings?.hiddenImages ?? {};
    const versionHiddenImages = input.modelVersionId
      ? hiddenImages[input.modelVersionId] ?? []
      : [];
    const pinnedPosts = modelGallerySettings?.pinnedPosts ?? {};
    const versionPinnedPosts = input.modelVersionId ? pinnedPosts[input.modelVersionId] ?? [] : [];

    if (versionPinnedPosts.length && !cursor) {
      const { items: pinnedPostsImages } = await fetchFn({
        ...input,
        limit: limit * 4,
        useCombinedNsfwLevel: !features.canViewNsfw,
        followed: false,
        postIds: versionPinnedPosts,
        user,
        headers: { src: 'getImagesAsPostsInfiniteHandler' },
        include: [...input.include, 'tagIds', 'profilePictures'],
        useLogicalReplica: features.logicalReplica,
      });

      for (const image of pinnedPostsImages) {
        if (!image?.postId) continue;
        if (!pinned[image.postId]) pinned[image.postId] = [];
        pinned[image.postId].push(image);
      }
    }

    while (true) {
      // TODO handle/remove all these (headers, include, ids)
      const { nextCursor, items } = await fetchFn({
        ...input,
        followed: false,
        useCombinedNsfwLevel: !features.canViewNsfw,
        cursor,
        ids: fetchHidden ? versionHiddenImages : undefined,
        limit: Math.ceil(limit * 2), // Overscan so that I can merge by postId
        user,
        headers: { src: 'getImagesAsPostsInfiniteHandler' },
        include: [...input.include, 'tagIds', 'profilePictures'],
        useLogicalReplica: features.logicalReplica,
      });

      // Merge images by postId
      for (const image of items) {
        // Skip images that aren't part of a post or are pinned
        if (!image?.postId || versionPinnedPosts.includes(image.postId)) continue;
        if (!posts[image.postId]) posts[image.postId] = [];
        posts[image.postId].push(image);
      }

      // If there are no more images, stop
      cursor = nextCursor;
      if (!cursor) break;

      // If there are enough posts, stop
      if (Object.keys(posts).length >= limit) break;
      remaining = limit - Object.keys(posts).length;
    }

    const mergedPosts = Object.values({ ...pinned, ...posts });

    // Get reviews from the users who created the posts
    const userIds = [...new Set(mergedPosts.map(([post]) => post.user.id).filter(isDefined))];
    const reviews = await dbRead.resourceReview.findMany({
      where: {
        userId: { in: userIds },
        modelId: input.modelId,
        modelVersionId: input.modelVersionId,
      },
      select: {
        userId: true,
        rating: true,
        details: true,
        id: true,
        modelVersionId: true,
        recommended: true,
      },
      orderBy: { rating: 'desc' },
    });

    // Prepare the results
    const results = mergedPosts.map((images) => {
      const [image] = images;
      const user = image.user;
      const review = reviews.find((review) => review.userId === user.id);
      // TODO meili has sortAt as a string, not a date
      const createdAt = images.map((image) => new Date(image.sortAt)).sort()[0];

      if (input.sort === ImageSort.Newest) images.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const imageNsfwLevels = images.map((x) => x.nsfwLevel);
      let nsfwLevel = 0;
      for (const imageNsfwLevel of imageNsfwLevels) {
        nsfwLevel = Flags.addFlag(nsfwLevel, imageNsfwLevel);
      }

      return {
        postId: image.postId as number,
        // postTitle: image.postTitle,
        pinned: !!(image.postId && pinned[image.postId]),
        nsfwLevel,
        modelVersionId: image.modelVersionId,
        publishedAt: image.publishedAt,
        sortAt: image.sortAt,
        createdAt,
        user,
        images,
        review: review
          ? {
              rating: review.rating,
              details: review.details,
              recommended: review.recommended,
              id: review.id,
            }
          : undefined,
      };
    });

    if (input.sort === ImageSort.Newest)
      results.sort((a, b) => {
        // sort by createdAt, but if it pinned, sort by pinned first respecting createdAt
        const aCreatedAt = a.createdAt.getTime();
        const bCreatedAt = b.createdAt.getTime();

        if (a.pinned && b.pinned) return bCreatedAt - aCreatedAt;
        if (a.pinned) return -1;
        if (b.pinned) return 1;
        return bCreatedAt - aCreatedAt;
      });
    else if (input.sort === ImageSort.MostReactions)
      results.sort((a, b) => {
        const aReactions = getReactionTotals(a);
        const bReactions = getReactionTotals(b);

        if (a.pinned && b.pinned) return bReactions - aReactions;
        if (a.pinned) return -1;
        if (b.pinned) return 1;
        return bReactions - aReactions;
      });
    else if (input.sort === ImageSort.MostComments)
      results.sort((a, b) => {
        const aComments = a.images[0].stats?.commentCountAllTime ?? 0;
        const bComments = b.images[0].stats?.commentCountAllTime ?? 0;

        if (a.pinned && b.pinned) return bComments - aComments;
        if (a.pinned) return -1;
        if (b.pinned) return 1;
        return bComments - aComments;
      });
    // else if (input.sort === ImageSort.MostTipped)
    //   results.sort((a, b) => {
    //     const aTips = a.images[0].stats?.tippedAmountCountAllTime ?? 0;
    //     const bTips = b.images[0].stats?.tippedAmountCountAllTime ?? 0;
    //     if (aTips < bTips) return 1;
    //     if (aTips > bTips) return -1;
    //     return 0;
    //   });
    else if (input.sort === ImageSort.MostCollected)
      results.sort((a, b) => {
        const aCollections = a.images[0].stats?.collectedCountAllTime ?? 0;
        const bCollections = b.images[0].stats?.collectedCountAllTime ?? 0;

        if (a.pinned && b.pinned) return bCollections - aCollections;
        if (a.pinned) return -1;
        if (b.pinned) return 1;
        return bCollections - aCollections;
      });
    else if (input.sort === ImageSort.Oldest)
      results.sort((a, b) => {
        const aCreatedAt = a.createdAt.getTime();
        const bCreatedAt = b.createdAt.getTime();

        if (a.pinned && b.pinned) return aCreatedAt - bCreatedAt;
        if (a.pinned) return -1;
        if (b.pinned) return 1;
        return aCreatedAt - bCreatedAt;
      });

    return {
      nextCursor: cursor,
      items: results,
    };
  } catch (error) {
    console.log({ error });
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const getImageHandler = async ({ input, ctx }: { input: GetImageInput; ctx: Context }) => {
  try {
    const result = await getImage({
      ...input,
      userId: ctx.user?.id,
      isModerator: ctx.user?.isModerator,
    });

    if (ctx.user && !ctx.user.isModerator) {
      const blocked = await amIBlockedByUser({ userId: ctx.user.id, targetUserId: result.user.id });
      if (blocked) throw throwNotFoundError();
    }

    return result;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export type ImageResourceModel = AsyncReturnType<typeof getImageResourcesHandler>[0];
export const getImageResourcesHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    return await getImageResources({ ...input });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const getEntitiesCoverImageHandler = async ({ input }: { input: GetEntitiesCoverImage }) => {
  try {
    return await getEntityCoverImage({ ...input, include: ['tags'] });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

// #endregion

export const getModeratorReviewQueueHandler = async ({
  input,
  ctx,
}: {
  input: ImageReviewQueueInput;
  ctx: Context;
}) => {
  try {
    return await getImageModerationReviewQueue({
      ...input,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const getImageContestCollectionDetailsHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    const collectionItems = await getImageContestCollectionDetails({
      ...input,
      userId: ctx.user?.id,
    });
    const imageId = collectionItems?.[0]?.imageId;
    if (!imageId) return { collectionItems, post: null };

    const post = await getPostDetailByImageId({ imageId });
    return { collectionItems, post };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export function setVideoThumbnailController({
  input,
  ctx,
}: {
  input: SetVideoThumbnailInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { id: userId, isModerator } = ctx.user;
    return setVideoThumbnail({ ...input, userId, isModerator });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
}

// This is only available for collections
export async function updateImageAcceptableMinorHandler({
  input,
  ctx,
}: {
  input: UpdateImageAcceptableMinorInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { collectionId } = input;
    const { id: userId, isModerator } = ctx.user;

    const permissions = await getUserCollectionPermissionsById({
      id: collectionId,
      userId,
      isModerator,
    });
    if (!permissions.manage) throw throwAuthorizationError();

    const image = await updateImageAcceptableMinor(input);
    return image;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
}

export async function handleUpdateImageNsfwLevel({
  input,
  ctx,
}: {
  input: UpdateImageNsfwLevelOutput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { id: userId, isModerator } = ctx.user;
    const updatedNsfwLevel = await updateImageNsfwLevel({ ...input, userId, isModerator });

    if (isModerator) {
      // Update knights of new order pending votes and remove it from new order queue
      await updatePendingImageRatings({ imageId: input.id, rating: input.nsfwLevel });
      const valueInQueue = await isImageInQueue({
        imageId: input.id,
        rankType: [NewOrderRankType.Knight, NewOrderRankType.Templar, 'Inquisitor'],
      });
      if (valueInQueue) valueInQueue.pool.reset({ id: input.id });
    }

    return updatedNsfwLevel;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
}
