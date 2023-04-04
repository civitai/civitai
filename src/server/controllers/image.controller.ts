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
import { ReportReason, ReportStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { Context } from '~/server/createContext';
import { dbRead } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  GetModelVersionImagesSchema,
  GetReviewImagesSchema,
  GetGalleryImageInput,
  GetImageConnectionsSchema,
  ImageUpdateSchema,
  UpdateImageInput,
} from '~/server/schema/image.schema';
import { imageGallerySelect } from '~/server/selectors/image.selector';
import {
  getModelVersionImages,
  getReviewImages,
  getGalleryImages,
  deleteImageById,
  updateImageById,
  updateImageReportStatusByReason,
  getImageConnectionsById,
  updateImage,
} from '~/server/services/image.service';
import { createNotification } from '~/server/services/notification.service';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { ImageSort } from '~/server/common/enums';

export const getModelVersionImagesHandler = ({
  input: { modelVersionId },
}: {
  input: GetModelVersionImagesSchema;
}) => {
  try {
    return getModelVersionImages({ modelVersionId });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getReviewImagesHandler = ({
  input: { reviewId },
}: {
  input: GetReviewImagesSchema;
}) => {
  try {
    return getReviewImages({ reviewId });
  } catch (error) {
    throw throwDbError(error);
  }
};

export type GalleryImageDetail = AsyncReturnType<typeof getGalleryImageDetailHandler>;
export const getGalleryImageDetailHandler = async ({
  input: { id },
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    const isMod = ctx.user?.isModerator;
    const item = await dbRead.image.findFirst({
      where: { id, OR: isMod ? undefined : [{ needsReview: false }, { userId: ctx.user?.id }] },
      // TODO.gallery - If the gallery is infinite, use the current gallery filters. If the gallery is finite, use MetricTimeFrame.AllTime
      select: imageGallerySelect({ user: ctx.user }),
    });
    if (!item) throw throwNotFoundError(`No image with id ${id} found`);
    const { stats, tags, ...image } = item;
    return {
      ...image,
      metrics: {
        likeCount: stats?.likeCountAllTime ?? 0,
        dislikeCount: stats?.dislikeCountAllTime ?? 0,
        laughCount: stats?.laughCountAllTime ?? 0,
        cryCount: stats?.cryCountAllTime ?? 0,
        heartCount: stats?.heartCountAllTime ?? 0,
        commentCount: stats?.commentCountAllTime ?? 0,
      },
      tags: tags.map(({ tag, ...other }) => ({ ...tag, ...other })),
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const getGalleryImagesInfiniteHandler = async ({
  input: { limit, ...input },
  ctx,
}: {
  input: GetGalleryImageInput;
  ctx: Context;
}) => {
  try {
    const take = limit + 1;
    const items = await getGalleryImages({
      limit: take,
      ...input,
      infinite: true,
      user: ctx.user,
    });

    let nextCursor: number | undefined;
    if (items.length > limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    return {
      nextCursor,
      items: items.map(({ tags, ...item }) => ({
        ...item,
        tags: tags.map(({ tag, ...other }) => ({ ...tag, ...other })),
      })),
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

type SortableImage = {
  nsfw: boolean;
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

export type GetGalleryImagesReturnType = AsyncReturnType<typeof getGalleryImagesHandler>;
export const getGalleryImagesHandler = async ({
  input,
  ctx,
}: {
  input: GetGalleryImageInput;
  ctx: Context;
}) => {
  try {
    const items = await getGalleryImages({
      ...input,
      user: ctx.user,
      // orderBy: [{ connections: { index: 'asc' } }, { id: 'desc' }], // Disabled for performance reasons
    });
    const parsedItems = items.map(({ tags, ...item }) => ({
      ...item,
      tags: tags.map(({ tag, ...other }) => ({ ...tag, ...other })),
    }));

    const isOwnerOrModerator =
      parsedItems.every((x) => x.user.id === ctx.user?.id) || ctx.user?.isModerator;
    const prioritizeSafeImages = !ctx.user || (ctx.user?.showNsfw && ctx.user?.blurNsfw);

    return prioritizeSafeImages && !isOwnerOrModerator
      ? parsedItems.sort((a, b) => (a.nsfw === b.nsfw ? sortByIndex(a, b) : a.nsfw ? 1 : -1))
      : parsedItems.sort(sortByIndex);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const moderateImageHandler = async ({ input }: { input: ImageModerationSchema }) => {
  try {
    await moderateImages(input);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const deleteImageHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const image = await deleteImageById(input);
    if (!image) throw throwNotFoundError(`No image with id ${input.id} found`);

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
        user: { select: { id: true } },
        imagesOnModels: {
          select: { modelVersion: { select: { model: { select: { name: true } } } } },
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
      userId: image.user.id,
      type: 'tos-violation',
      details: {
        modelName: image.imagesOnModels?.modelVersion.model.name,
        entity: 'image',
      },
    }).catch((error) => {
      // Print out any errors
      console.error(error);
    });

    // Delete image
    await deleteImageById({ id });
    return image;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const getImageConnectionDataHandler = async ({
  input,
}: {
  input: GetImageConnectionsSchema;
}) => {
  try {
    const image = await getImageConnectionsById(input);
    if (!image) throw throwNotFoundError(`No image with id ${input.id}`);

    const { connections } = image;
    return connections;
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
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
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
      // TODO Optimize: override the select statement to exclude repeated elements like creator data
      const { nextCursor, items } = await getAllImages({
        ...input,
        cursor,
        limit: Math.ceil(limit * 3), // Overscan so that I can merge by postId
        userId: ctx.user?.id,
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
      select: { userId: true, rating: true, details: true, id: true },
    });

    // Prepare the results
    const results = Object.values(posts).map((images) => {
      const user = images[0].user;
      const review = reviews.find((review) => review.userId === user.id);
      const createdAt = images.map((image) => image.createdAt).sort()[0];
      return {
        postId: images[0].postId as number,
        publishedAt: images[0].publishedAt,
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
        const aReactions = Object.values(a.images[0].stats ?? {}).reduce((a, b) => a + b, 0);
        const bReactions = Object.values(b.images[0].stats ?? {}).reduce((a, b) => a + b, 0);
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
    return await getImage({ ...input, userId: ctx.user?.id, isModerator: ctx.user?.isModerator });
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
