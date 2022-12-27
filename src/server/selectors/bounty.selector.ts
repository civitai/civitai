import { Prisma } from '@prisma/client';
import { imageSelect } from '~/server/selectors/image.selector';
import { simpleUserSelect } from '~/server/selectors/user.selector';

export const getAllBountiesSelect = Prisma.validator<Prisma.BountySelect>()({
  id: true,
  name: true,
  type: true,
  nsfw: true,
  images: {
    orderBy: { index: 'asc' },
    take: 1,
    select: {
      image: { select: imageSelect },
    },
  },
});

export const getBountyDetailsSelect = Prisma.validator<Prisma.BountySelect>()({
  id: true,
  name: true,
  description: true,
  type: true,
  nsfw: true,
  user: { select: simpleUserSelect },
  hunters: {
    select: {
      id: true,
      user: { select: simpleUserSelect },
      images: { select: { index: true, image: { select: imageSelect } } },
    },
  },
  benefactors: {
    orderBy: { contribution: 'desc' },
    select: { id: true, contribution: true, user: { select: simpleUserSelect } },
  },
  tags: {
    select: { id: true, name: true },
  },
  images: {
    orderBy: { index: 'asc' },
    select: {
      index: true,
      image: { select: imageSelect },
    },
  },
  files: {
    take: 1,
    select: {
      id: true,
      url: true,
      sizeKB: true,
      name: true,
      type: true,
    },
  },
});
