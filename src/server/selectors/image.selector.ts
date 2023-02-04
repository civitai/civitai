import { Prisma } from '@prisma/client';
import { SessionUser } from 'next-auth';

import { getReactionsSelect } from '~/server/selectors/reaction.selector';

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
