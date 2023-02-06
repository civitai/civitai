import { TRPCError } from '@trpc/server';
import { Context } from '~/server/createContext';
import { prisma } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  GetModelVersionImagesSchema,
  GetReviewImagesSchema,
  GetGalleryImageInput,
} from '~/server/schema/image.schema';
import { imageGallerySelect } from '~/server/selectors/image.selector';
import {
  getModelVersionImages,
  getReviewImages,
  getGalleryImages,
  deleteImageById,
} from '~/server/services/image.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';

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

export type GetGalleryImageDetailReturnType = AsyncReturnType<typeof getGalleryImageDetailHandler>;
export const getGalleryImageDetailHandler = async ({
  input: { id },
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    const item = await prisma.image.findUnique({
      where: { id },
      // TODO.gallery - If the gallery is infinite, use the current gallery filters. If the gallery is finite, use MetricTimeFrame.AllTime
      select: imageGallerySelect({ user: ctx.user }),
    });
    if (!item) throw throwNotFoundError(`No image with id ${id} found`);
    const { stats, ...image } = item;
    return {
      ...image,
      metrics: {
        likeCount: stats?.likeCountAllTime,
        dislikeCount: stats?.dislikeCountAllTime,
        laughCount: stats?.laughCountAllTime,
        cryCount: stats?.cryCountAllTime,
        heartCount: stats?.heartCountAllTime,
        commentCount: stats?.commentCountAllTime,
      },
    };
  } catch (error) {
    throw throwDbError(error);
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
      items,
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
      // orderBy: [{ connections: { index: 'asc' } }, { createdAt: 'desc' }], // Disabled for performance reasons
    });

    const isOwnerOrModerator =
      items.every((x) => x.user.id === ctx.user?.id) || ctx.user?.isModerator;
    const prioritizeSafeImages = !ctx.user || (ctx.user?.showNsfw && ctx.user?.blurNsfw);

    return prioritizeSafeImages && !isOwnerOrModerator
      ? items.sort((a, b) => (a.nsfw === b.nsfw ? sortByIndex(a, b) : a.nsfw ? 1 : -1))
      : items.sort(sortByIndex);
  } catch (error) {
    throw throwDbError(error);
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
