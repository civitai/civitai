import { Prisma } from '@prisma/client';

export const imagePreviewSelect = Prisma.validator<Prisma.ImageSelect>()({
  width: true,
  url: true,
  height: true,
  name: true,
  hash: true,
});

export const imageSelect = Prisma.validator<Prisma.ImageSelect>()({
  id: true,
  name: true,
  url: true,
  nsfw: true,
  width: true,
  height: true,
  hash: true,
  prompt: true,
});

const image = Prisma.validator<Prisma.ImageArgs>()({ select: imageSelect });

export type ImageModel = Prisma.ImageGetPayload<typeof image>;
