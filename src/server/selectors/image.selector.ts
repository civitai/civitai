import { Prisma, TagTarget } from '@prisma/client';
import { SessionUser } from 'next-auth';

import { getImageGenerationProcess } from '~/server/common/model-helpers';
import { ImageUploadProps } from '~/server/schema/image.schema';
import { isTag } from '~/server/schema/tag.schema';
import { getNeedsReview } from '~/utils/image-metadata';

import { getReactionsSelect } from './reaction.selector';
import { simpleTagSelect } from './tag.selector';
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
  needsReview: true,
  tags: { select: { tag: { select: simpleTagSelect } } },
});

const { name, ...imageSelectWithoutName } = imageSelect;
export { imageSelectWithoutName };

const image = Prisma.validator<Prisma.ImageArgs>()({ select: imageSelect });

export type ImageModel = Prisma.ImageGetPayload<typeof image>;

export const imageGallerySelect = ({
  user,
  needsReview,
}: {
  user?: SessionUser;
  needsReview?: boolean;
}) =>
  Prisma.validator<Prisma.ImageSelect>()({
    ...imageSelect,
    createdAt: true,
    needsReview: true,
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
    analysis: needsReview ? true : false,
  });

export const prepareCreateImage = (image: ImageUploadProps) => {
  const payload: Omit<Prisma.ImageCreateInput, 'user'> = {
    ...image,
    needsReview: getNeedsReview(image),
    meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
    generationProcess: image.meta
      ? getImageGenerationProcess(image.meta as Prisma.JsonObject)
      : null,
    tags: image.tags
      ? {
          create: image.tags.map((tag) => ({
            tag: {
              connectOrCreate: {
                where: { id: tag.id },
                create: { ...tag, target: [TagTarget.Image] },
              },
            },
          })),
        }
      : undefined,
  };

  return payload;
};

export const prepareUpdateImage = (image: ImageUploadProps) => {
  const tags = image.tags?.map((tag) => ({ ...tag, name: tag.name.toLowerCase().trim() }));
  const payload: Prisma.ImageUpdateInput = {
    ...image,
    meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
    tags: tags
      ? {
          deleteMany: {
            NOT: tags.filter(isTag).map(({ id }) => ({ tagId: id })),
          },
          connectOrCreate: tags.filter(isTag).map((tag) => ({
            where: { tagId_imageId: { tagId: tag.id, imageId: image.id as number } },
            create: { tagId: tag.id },
          })),
          // user's can't create image tags right now
          // create: tags.filter(isNotTag).map((tag) => ({
          //   tag: {
          //     create: { ...tag, target: [TagTarget.Image] },
          //   },
          // })),
        }
      : undefined,
  };
  return payload;
};
