import { GetByIdInput } from '~/server/schema/base.schema';
import { Context } from '~/server/createContext';
import { imageGallerySelect } from '~/server/selectors/image.selector';
import { throwDbError } from '~/server/utils/errorHandling';
import {
  GetModelVersionImagesSchema,
  GetReviewImagesSchema,
  GetGalleryImageInput,
} from './../schema/image.schema';
import { getModelVersionImages, getReviewImages } from './../services/image.service';
import { prisma } from '~/server/db/client';
import { env } from '~/env/server.mjs';

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
export const getGalleryImageDetailHandler = async ({ input: { id } }: { input: GetByIdInput }) => {
  try {
    return await prisma.image.findUnique({ where: { id }, select: imageGallerySelect });
  } catch (error) {
    throw throwDbError(error);
  }
};

export type GetGalleryImagesReturnType = AsyncReturnType<typeof getGalleryImagesHandler>['items'];
export const getGalleryImagesHandler = async ({
  input: { limit, cursor, modelId, modelVersionId, reviewId, userId },
  ctx,
}: {
  input: GetGalleryImageInput;
  ctx: Context;
}) => {
  try {
    const canViewNsfw = ctx.user?.showNsfw ?? env.UNAUTHENTICATE_LIST_NSFW;
    // TODO - discuss with Justing
    const prioritizeSafeImages = !ctx.user || (ctx.user?.showNsfw && ctx.user?.blurNsfw);
    const take = limit + 1;

    const items = await prisma.image.findMany({
      cursor: cursor ? { id: cursor } : undefined,
      take,
      where: {
        // query modelId or modelVersionId
        userId,
        imagesOnModels:
          modelVersionId || modelId
            ? { modelVersionId, modelVersion: modelId ? { modelId } : undefined }
            : undefined,
        imagesOnReviews: reviewId ? { reviewId } : undefined,
        nsfw: !canViewNsfw ? { equals: false } : undefined,
        // TODO - excludedTagIds (hidden tags)
      },
      select: imageGallerySelect,
      orderBy: { createdAt: 'desc' },
    });

    let nextCursor: number | undefined;
    if (items.length > limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    } else if (!!modelId || !!modelVersionId || !!reviewId) {
      // TODO - don't do this
      // this condition should only trigger for galleries where
    }

    return {
      nextCursor,
      items,
    };
  } catch (error) {
    throw throwDbError(error);
  }
};
