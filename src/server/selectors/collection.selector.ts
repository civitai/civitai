import { ImageMetaProps } from '~/server/schema/image.schema';
import { simpleTagSelect } from './tag.selector';
import { Prisma } from '@prisma/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { imageSelect } from '~/server/selectors/image.selector';

export const collectionWithoutImageSelect = Prisma.validator<Prisma.CollectionSelect>()({
  id: true,
  name: true,
  description: true,
  read: true,
  write: true,
  type: true,
  nsfw: true,
  nsfwLevel: true,
  image: { select: imageSelect },
  mode: true,
  metadata: true,
  availability: true,
  userId: true,
  tags: {
    select: {
      tag: {
        select: {
          id: true,
          name: true,
        },
      },
      filterableOnly: true,
    },
  },
});

export const collectionSelect = Prisma.validator<Prisma.CollectionSelect>()({
  ...collectionWithoutImageSelect,
  image: { select: imageSelect },
});
