import { Prisma, TagTarget } from '@prisma/client';
import { SessionUser } from 'next-auth';
import { getImageGenerationProcess } from '~/server/common/model-helpers';
import { ImageUploadProps } from '~/server/schema/image.schema';

import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import { simpleTagSelect } from '~/server/selectors/tag.selector';
import { detectNsfwImage } from '~/utils/image-metadata';

import { userWithCosmeticsSelect } from './user.selector';

export const imageSelect = Prisma.validator<Prisma.ImageSelect>()({
  id: true,
  name: true,
  url: true,
  nsfw: true,
  width: true,
  height: true,
  hash: true,
  meta: true,
  generationProcess: true,
  tags: { select: { tag: { select: simpleTagSelect } } },
});

const { id, name, ...imageSelectWithoutId } = imageSelect;
export { imageSelectWithoutId };

const image = Prisma.validator<Prisma.ImageArgs>()({ select: imageSelect });

export type ImageModel = Prisma.ImageGetPayload<typeof image>;

export const imageGallerySelect = ({ user }: { user?: SessionUser }) =>
  Prisma.validator<Prisma.ImageSelect>()({
    ...imageSelect,
    createdAt: true,
    user: { select: userWithCosmeticsSelect },
    connections: {
      select: {
        index: true,
        modelId: true,
        reviewId: true,
      },
    },
    stats: {
      select: {
        cryCountAllTime: true,
        dislikeCountAllTime: true,
        heartCountAllTime: true,
        laughCountAllTime: true,
        likeCountAllTime: true,
        commentCountAllTime: true,
      },
    },
    reactions: {
      where: { userId: user?.id },
      take: !user?.id ? 0 : undefined,
      select: getReactionsSelect,
    },
  });

const MINOR_DETECTION_AGE = 20;
export const prepareCreateImage = (image: ImageUploadProps) => {
  const assessedNSFW = image.analysis ? detectNsfwImage(image.analysis) : true; // Err on side of caution
  const assessedMinor =
    image.analysis?.faces && image.analysis.faces.some((x) => x.age <= MINOR_DETECTION_AGE);
  const needsReview = (image.nsfw === true || assessedNSFW) && assessedMinor;

  const payload: Omit<Prisma.ImageCreateInput, 'user'> = {
    ...image,
    needsReview,
    meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
    generationProcess: image.meta
      ? getImageGenerationProcess(image.meta as Prisma.JsonObject)
      : null,
    tags: {
      create: image.tags?.map((tag) => ({
        tag: {
          connectOrCreate: {
            where: { id: tag.id },
            create: { ...tag, target: [TagTarget.Image] },
          },
        },
      })),
    },
  };

  return payload;
};
