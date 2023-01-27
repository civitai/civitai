import { MetricTimeframe } from '@prisma/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { Context } from '~/server/createContext';
import { imageGallerySelect } from '~/server/selectors/image.selector';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import {
  GetModelVersionImagesSchema,
  GetReviewImagesSchema,
  GetGalleryImageInput,
} from './../schema/image.schema';
import {
  getModelVersionImages,
  getReviewImages,
  getGalleryImages,
} from './../services/image.service';
import { prisma } from '~/server/db/client';
import { input } from '@tensorflow/tfjs';

export const getModelVersionImagesHandler = async ({
  input: { modelVersionId },
}: {
  input: GetModelVersionImagesSchema;
}) => {
  try {
    return await getModelVersionImages({ modelVersionId });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getReviewImagesHandler = async ({
  input: { reviewId },
}: {
  input: GetReviewImagesSchema;
}) => {
  try {
    return await getReviewImages({ reviewId });
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
    const image = await prisma.image.findUnique({
      where: { id },
      // TODO.gallery - If the gallery is infinite, use the current gallery filters. If the gallery is finite, use MetricTimeFrame.AllTime
      select: imageGallerySelect({ period: MetricTimeframe.AllTime, user: ctx.user }),
    });
    if (!image) throw throwNotFoundError();
    return { ...image, metrics: image.metrics[0] };
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

export type GetGalleryImagesReturnType = AsyncReturnType<typeof getGalleryImagesHandler>;
export const getGalleryImagesHandler = async ({
  input,
  ctx,
}: {
  input: GetGalleryImageInput;
  ctx: Context;
}) => {
  try {
    const prioritizeSafeImages = !ctx.user || (ctx.user?.showNsfw && ctx.user?.blurNsfw);
    const items = await getGalleryImages({
      ...input,
      user: ctx.user,
      orderBy: [{ connections: { index: 'asc' } }, { createdAt: 'desc' }],
    });
    return prioritizeSafeImages
      ? items.sort((a, b) => (a.nsfw === b.nsfw ? 0 : a.nsfw ? 1 : -1))
      : items;
  } catch (error) {
    throw throwDbError(error);
  }
};
