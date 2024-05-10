import {
  GetEntitiesCoverImage,
  GetImageInput,
  GetInfiniteImagesOutput,
  ImageModerationSchema,
  ImageReviewQueueInput,
} from './../schema/image.schema';
import {
  getAllImages,
  getEntityCoverImage,
  getImage,
  getImageDetail,
  getImageModerationReviewQueue,
  getImageResources,
  getResourceIdsForImages,
  getTagNamesForImages,
  moderateImages,
} from './../services/image.service';
import { ReportReason, ReportStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { Context } from '~/server/createContext';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { UpdateImageInput } from '~/server/schema/image.schema';
import {
  deleteImageById,
  updateImageReportStatusByReason,
  updateImage,
} from '~/server/services/image.service';
import { createNotification } from '~/server/services/notification.service';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  BlockedReason,
  ImageSort,
  NsfwLevel,
  SearchIndexUpdateQueueAction,
} from '~/server/common/enums';
import { trackModActivity } from '~/server/services/moderator.service';
import { hasEntityAccess } from '../services/common.service';
import { getGallerySettingsByModelId } from '~/server/services/model.service';
import { Flags } from '~/shared/utils';
import { getNsfwLevelDeprecatedReverseMapping } from '~/shared/constants/browsingLevel.constants';
import { imagesSearchIndex } from '~/server/search-index';

export const moderateImageHandler = async ({
  input,
  ctx,
}: {
  input: ImageModerationSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const affected = await moderateImages(input);
    await trackModActivity(ctx.user.id, {
      entityType: 'image',
      entityId: input.ids,
      activity: 'review',
    });
    if (affected) {
      const ids = affected.map((x) => x.id);
      const imageTags = await getTagNamesForImages(ids);
      const imageResources = await getResourceIdsForImages(ids);
      for (const { id, userId, nsfwLevel } of affected) {
        const tags = imageTags[id] ?? [];
        tags.push(input.reviewType ?? 'other');
        const resources = imageResources[id] ?? [];
        await ctx.track.image({
          type: 'DeleteTOS',
          imageId: id,
          nsfw: getNsfwLevelDeprecatedReverseMapping(nsfwLevel),
          tags,
          resources,
          tosReason: input.reviewType ?? 'other',
          ownerId: userId,
        });
      }
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
      await ctx.track.image({
        type: 'Delete',
        imageId: input.id,
        nsfw: getNsfwLevelDeprecatedReverseMapping(image.nsfwLevel),
        tags: imageTags.map((x) => x.tagName),
        ownerId: image.userId,
      });
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
    const { user } = ctx;
    const { id } = input;
    if (!user.isModerator) throw throwAuthorizationError('Only moderators can set TOS violation');

    // Get details of the image
    const image = await dbRead.image.findFirst({
      where: { id },
      select: {
        nsfwLevel: true,
        userId: true,
        postId: true,
        post: {
          select: {
            title: true,
          },
        },
      },
    });
    if (!image) throw throwNotFoundError(`No image with id ${id}`);

    // Update any TOS Violation reports
    await updateImageReportStatusByReason({
      id,
      reason: ReportReason.TOSViolation,
      status: ReportStatus.Actioned,
    });

    // Create notifications in the background
    createNotification({
      userId: image.userId,
      type: 'tos-violation',
      category: 'System',
      details: {
        modelName: image.post?.title ?? `post #${image.postId}`,
        entity: 'image',
        url: `/posts/${image.postId}`,
      },
    }).catch((error) => {
      // Print out any errors
      console.error(error);
    });

    // Block image
    // This used to be a delete, but the mod team prefers to have the clean up happen later
    await dbWrite.image.updateMany({
      where: { id },
      data: {
        needsReview: null,
        ingestion: 'Blocked',
        nsfw: 'Blocked',
        nsfwLevel: NsfwLevel.Blocked,
        blockedFor: BlockedReason.Moderated,
        updatedAt: new Date(),
      },
    });

    await imagesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);

    const imageTags = await getTagNamesForImages([id]);
    const imageResources = await getResourceIdsForImages([id]);
    await ctx.track.image({
      type: 'DeleteTOS',
      imageId: id,
      nsfw: getNsfwLevelDeprecatedReverseMapping(image.nsfwLevel),
      tags: imageTags[id] ?? [],
      resources: imageResources[id] ?? [],
      tosReason: 'manual',
      ownerId: image.userId,
    });
    return image;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

// export const updateImageHandler = async ({ input }: { input: UpdateImageInput }) => {
//   try {
//     return await updateImage({ ...input });
//   } catch (error) {
//     if (error instanceof TRPCError) throw error;
//     else throw throwDbError(error);
//   }
// };

export const getImageDetailHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    return await getImageDetail({ ...input });
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
  try {
    return await getAllImages({
      ...input,
      user: ctx.user,
      headers: { src: 'getInfiniteImagesHandler' },
      include: [...input.include, 'tagIds'],
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
export const getImagesAsPostsInfiniteHandler = async ({
  input: { limit, cursor, hidden, ...input },
  ctx,
}: {
  input: GetInfiniteImagesOutput;
  ctx: Context;
}) => {
  try {
    const posts: Record<number, AsyncReturnType<typeof getAllImages>['items']> = {};
    const pinned: Record<number, AsyncReturnType<typeof getAllImages>['items']> = {};
    let remaining = limit;
    const fetchHidden = hidden && input.modelId;
    const modelGallerySettings = input.modelId
      ? await getGallerySettingsByModelId({ id: input.modelId })
      : null;
    const hiddenImagesIds = modelGallerySettings?.hiddenImages ?? [];
    const pinnedPosts = modelGallerySettings?.pinnedPosts ?? {};
    const versionPinnedPosts =
      pinnedPosts && input.modelVersionId ? pinnedPosts[input.modelVersionId] ?? [] : [];

    if (versionPinnedPosts.length && !cursor) {
      const { items: pinnedPostsImages } = await getAllImages({
        ...input,
        limit: limit * 3,
        followed: false,
        postIds: versionPinnedPosts,
        user: ctx.user,
        headers: { src: 'getImagesAsPostsInfiniteHandler' },
        include: [...input.include, 'tagIds', 'profilePictures'],
      });

      for (const image of pinnedPostsImages) {
        if (!image?.postId) continue;
        if (!pinned[image.postId]) pinned[image.postId] = [];
        pinned[image.postId].push(image);
      }
    }

    while (true) {
      const { nextCursor, items } = await getAllImages({
        ...input,
        followed: false,
        cursor,
        ids: fetchHidden ? hiddenImagesIds : undefined,
        limit: Math.ceil(limit * 3), // Overscan so that I can merge by postId
        user: ctx.user,
        headers: { src: 'getImagesAsPostsInfiniteHandler' },
        include: [...input.include, 'tagIds', 'profilePictures'],
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
    const userIds = [...new Set(mergedPosts.map(([post]) => post.user.id))];
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
      const createdAt = images.map((image) => image.createdAt).sort()[0];

      if (input.sort === ImageSort.Newest) images.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const imageNsfwLevels = images.map((x) => x.nsfwLevel);
      let nsfwLevel = 0;
      for (const imageNsfwLevel of imageNsfwLevels) {
        nsfwLevel = Flags.addFlag(nsfwLevel, imageNsfwLevel);
      }

      return {
        postId: image.postId as number,
        postTitle: image.postTitle,
        pinned: image.postId && pinned[image.postId] ? true : false,
        nsfwLevel,
        modelVersionId: image.modelVersionId,
        publishedAt: image.publishedAt,
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

    if (result.postId) {
      const [access] = await hasEntityAccess({
        userId: ctx?.user?.id,
        isModerator: ctx?.user?.isModerator,
        entityIds: [result.postId],
        entityType: 'Post',
      });

      // Cannot get images by ID without access
      if (!access?.hasAccess) {
        return null;
      }
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
