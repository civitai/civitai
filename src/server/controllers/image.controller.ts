import {
  GetImageInput,
  GetInfiniteImagesInput,
  ImageModerationSchema,
} from './../schema/image.schema';
import {
  getAllImages,
  getImage,
  getImageDetail,
  getImageResources,
  moderateImages,
} from './../services/image.service';
import { NsfwLevel, ReportReason, ReportStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { Context } from '~/server/createContext';
import { dbRead } from '~/server/db/client';
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
import { ImageSort } from '~/server/common/enums';
import { trackModActivity } from '~/server/services/moderator.service';

type SortableImage = {
  nsfw: NsfwLevel;
  createdAt: Date;
  connections: {
    index: number | null;
  } | null;
};
const sortByIndex = (a: SortableImage, b: SortableImage) => {
  const aIndex = a.connections?.index ?? 0;
  const bIndex = b.connections?.index ?? 0;
  return aIndex - bIndex;
};

export const moderateImageHandler = async ({
  input,
  ctx,
}: {
  input: ImageModerationSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    await moderateImages(input);
    await trackModActivity(ctx.user.id, {
      entityType: 'image',
      entityId: input.ids,
      activity: 'review',
    });
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
      },
      select: {
        tagName: true,
      },
    });

    const image = await deleteImageById(input);

    if (image) {
      await ctx.track.image({
        type: 'Delete',
        imageId: image.id,
        nsfw: image.nsfw,
        tags: imageTags.map((x) => x.tagName),
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
        nsfw: true,
        tags: {
          select: {
            tag: {
              select: {
                name: true,
              },
            },
          },
        },
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
      details: {
        modelName: image.post?.title ?? `post #${image.postId}`,
        entity: 'image',
        url: `/posts/${image.postId}`,
      },
    }).catch((error) => {
      // Print out any errors
      console.error(error);
    });

    // Delete image
    await deleteImageById({ id });

    await ctx.track.image({
      type: 'DeleteTOS',
      imageId: id,
      nsfw: image.nsfw,
      tags: image.tags.map((x) => x.tag.name),
    });
    return image;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const updateImageHandler = async ({ input }: { input: UpdateImageInput }) => {
  try {
    return await updateImage({ ...input });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

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
  input: GetInfiniteImagesInput;
  ctx: Context;
}) => {
  try {
    return await getAllImages({
      ...input,
      userId: ctx.user?.id,
      isModerator: ctx.user?.isModerator,
      headers: { src: 'getInfiniteImagesHandler' },
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
  input: { limit, cursor, ...input },
  ctx,
}: {
  input: GetInfiniteImagesInput;
  ctx: Context;
}) => {
  try {
    const posts: Record<number, AsyncReturnType<typeof getAllImages>['items']> = {};
    let remaining = limit;

    while (true) {
      const { nextCursor, items } = await getAllImages({
        ...input,
        cursor,
        limit: Math.ceil(limit * 3), // Overscan so that I can merge by postId
        userId: ctx.user?.id,
        headers: { src: 'getImagesAsPostsInfiniteHandler' },
      });

      // Merge images by postId
      for (const image of items) {
        if (!image?.postId) continue; // Skip images that aren't part of a post
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

    // Get reviews from the users who created the posts
    const userIds = [...new Set(Object.values(posts).map(([post]) => post.user.id))];
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
      },
      orderBy: { rating: 'desc' },
    });

    // Prepare the results
    const results = Object.values(posts).map((images) => {
      const [image] = images;
      const user = image.user;
      const review = reviews.find((review) => review.userId === user.id);
      const createdAt = images.map((image) => image.createdAt).sort()[0];
      if (input.sort === ImageSort.Newest) images.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return {
        postId: image.postId as number,
        postTitle: image.postTitle,
        modelVersionId: image.modelVersionId,
        publishedAt: image.publishedAt,
        createdAt,
        user,
        images,
        review: review
          ? {
              rating: review.rating,
              details: review?.details,
              id: review.id,
            }
          : undefined,
      };
    });

    if (input.sort === ImageSort.Newest)
      results.sort((a, b) => {
        if (a.createdAt < b.createdAt) return 1;
        if (a.createdAt > b.createdAt) return -1;
        return 0;
      });
    else if (input.sort === ImageSort.MostReactions)
      results.sort((a, b) => {
        const aReactions = getReactionTotals(a);
        const bReactions = getReactionTotals(b);
        if (aReactions < bReactions) return 1;
        if (aReactions > bReactions) return -1;
        return 0;
      });
    else if (input.sort === ImageSort.MostComments)
      results.sort((a, b) => {
        const aComments = a.images[0].stats?.commentCountAllTime ?? 0;
        const bComments = b.images[0].stats?.commentCountAllTime ?? 0;
        if (aComments < bComments) return 1;
        if (aComments > bComments) return -1;
        return 0;
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
// #endregion

// export const getReportedImages = async ({
//   input,
//   ctx,
// }: {
//   input: any;
//   ctx: DeepNonNullable<Context>;
// }) => {
//   try {
//     const images = await dbRead.image.findMany({
//       where: {
//         reports: { some: { report: { status: 'Pending' } } },
//       },
//       select: {

//       }
//     });

//     return images;
//   } catch (error) {
//     throw throwDbError(error);
//   }
// };
