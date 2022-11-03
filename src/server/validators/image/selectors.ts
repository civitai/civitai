import { Prisma } from '@prisma/client';

export const imageSimpleSelect = Prisma.validator<Prisma.ImageSelect>()({
  id: true,
  name: true,
  url: true,
  nsfw: true,
});

export const imageDetailsSelect = Prisma.validator<Prisma.ImageSelect>()({
  ...imageSimpleSelect,
  prompt: true,
  height: true,
  width: true,
  hash: true,
});

const imageSimple = Prisma.validator<Prisma.ImageArgs>()({ select: imageSimpleSelect });
const imageDetails = Prisma.validator<Prisma.ImageArgs>()({ select: imageDetailsSelect });

export type ImageSimpleModel = Prisma.ImageGetPayload<typeof imageSimple>;
export type ImageDetailModel = Prisma.ImageGetPayload<typeof imageDetails>;
