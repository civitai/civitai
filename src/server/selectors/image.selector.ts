import { ImageIngestionStatus, Prisma } from '@prisma/client';

import { getImageGenerationProcess } from '~/server/common/model-helpers';
import { ImageUploadProps } from '~/server/schema/image.schema';

import { simpleTagSelect } from './tag.selector';

export const imageSelect = Prisma.validator<Prisma.ImageSelect>()({
  id: true,
  name: true,
  url: true,
  nsfw: true,
  width: true,
  height: true,
  hash: true,
  meta: true,
  userId: true,
  generationProcess: true,
  needsReview: true,
  scannedAt: true,
  postId: true,
  type: true,
  metadata: true,
  createdAt: true,
  tags: {
    select: {
      tag: { select: { ...simpleTagSelect, type: true } },
      automated: true,
      needsReview: true,
    },
    where: { disabled: false },
  },
});

export const profileImageSelect = Prisma.validator<Prisma.ImageSelect>()({
  id: true,
  name: true,
  url: true,
  nsfw: true,
  hash: true,
  userId: true,
  ingestion: true,
  type: true,
  width: true,
  height: true,
  metadata: true,
});
const profileImage = Prisma.validator<Prisma.ImageDefaultArgs>()({
  select: profileImageSelect,
});
export type ProfileImage = Prisma.ImageGetPayload<typeof profileImage>;

const { name, ...imageSelectWithoutName } = imageSelect;
export { imageSelectWithoutName };

const image = Prisma.validator<Prisma.ImageDefaultArgs>()({ select: imageSelect });
export type ImageModel = Prisma.ImageGetPayload<typeof image>;
export type ImageModelWithIngestion = ImageModel & { ingestion: ImageIngestionStatus };

export const prepareCreateImage = (image: ImageUploadProps) => {
  let name = image.name;
  if (!name && image.mimeType === 'image/gif') name = image.url + '.gif';

  const payload: Omit<Prisma.ImageCreateInput, 'user'> = {
    ...image,
    name,
    // needsReview: getNeedsReview(image),
    meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
    generationProcess: image.meta
      ? getImageGenerationProcess(image.meta as Prisma.JsonObject)
      : null,
    // tags: image.tags
    //   ? {
    //       create: image.tags.map((tag) => ({
    //         tag: {
    //           connectOrCreate: {
    //             where: { id: tag.id },
    //             create: { ...tag, target: [TagTarget.Image] },
    //           },
    //         },
    //       })),
    //     }
    //   : undefined,
    resources: undefined, // TODO.posts - this is a temp value to stop typescript from complaining
  };

  return payload;
};

export const prepareUpdateImage = (image: ImageUploadProps) => {
  // const tags = image.tags?.map((tag) => ({ ...tag, name: tag.name.toLowerCase().trim() }));
  const payload: Prisma.ImageUpdateInput = {
    ...image,
    meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
    // tags: tags
    //   ? {
    //       deleteMany: {
    //         NOT: tags.filter(isTag).map(({ id }) => ({ tagId: id })),
    //       },
    //       connectOrCreate: tags.filter(isTag).map((tag) => ({
    //         where: { tagId_imageId: { tagId: tag.id, imageId: image.id as number } },
    //         create: { tagId: tag.id },
    //       })),
    //       // user's can't create image tags right now
    //       // create: tags.filter(isNotTag).map((tag) => ({
    //       //   tag: {
    //       //     create: { ...tag, target: [TagTarget.Image] },
    //       //   },
    //       // })),
    //     }
    //   : undefined,
    resources: undefined, // TODO.posts - this is a temp value to stop typescript from complaining
  };
  return payload;
};

export const imageResourceHelperSelect = Prisma.validator<Prisma.ImageResourceHelperSelect>()({
  id: true,
  reviewId: true,
  reviewRating: true,
  reviewDetails: true,
  reviewCreatedAt: true,
  name: true,
  hash: true,
  modelVersionId: true,
  modelVersionName: true,
  modelVersionCreatedAt: true,
  modelId: true,
  modelName: true,
  modelRating: true,
  modelRatingCount: true,
  modelDownloadCount: true,
  modelCommentCount: true,
  modelFavoriteCount: true,
  modelType: true,
});

const imageResourceHelper = Prisma.validator<Prisma.ImageResourceHelperDefaultArgs>()({
  select: imageResourceHelperSelect,
});
export type ImageResourceHelperModel = Prisma.ImageResourceHelperGetPayload<
  typeof imageResourceHelper
>;
