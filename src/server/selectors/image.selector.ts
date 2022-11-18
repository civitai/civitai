import { Prisma } from '@prisma/client';

export const imageSelect = Prisma.validator<Prisma.ImageSelect>()({
  id: true,
  name: true,
  url: true,
  nsfw: true,
  width: true,
  height: true,
  hash: true,
  meta: true,
});

const image = Prisma.validator<Prisma.ImageArgs>()({ select: imageSelect });

export type ImageModel = Prisma.ImageGetPayload<typeof image>;
