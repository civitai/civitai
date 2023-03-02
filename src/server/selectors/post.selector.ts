import { simpleTagSelect } from './tag.selector';
import { Prisma } from '@prisma/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

export const postImageSelect = Prisma.validator<Prisma.ImageSelect>()({
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
  _count: {
    select: {
      resources: true,
      tags: true,
    },
  },
});
export type PostImage = Prisma.ImageGetPayload<typeof postImage>;
const postImage = Prisma.validator<Prisma.ImageArgs>()({ select: postImageSelect });

export const postSelect = Prisma.validator<Prisma.PostSelect>()({
  id: true,
  nsfw: true,
  title: true,
  scanned: true,
  modelVersionId: true,
  user: { select: userWithCosmeticsSelect },
  images: { select: postImageSelect },
  tags: { select: { tag: { select: simpleTagSelect } } },
});

export const postDetailSelect = Prisma.validator<Prisma.PostSelect>()({});
