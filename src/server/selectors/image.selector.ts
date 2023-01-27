import { Prisma, MetricTimeframe } from '@prisma/client';
import { SessionUser } from 'next-auth';

import { getReactionsSelect } from '~/server/selectors/reaction.selector';

import { simpleUserSelect } from './user.selector';

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

export const imageGallerySelect = ({
  period,
  user,
  infinite = false,
}: {
  period: MetricTimeframe;
  user?: SessionUser;
  infinite?: boolean;
}) =>
  Prisma.validator<Prisma.ImageSelect>()({
    ...imageSelect,
    createdAt: true,
    user: { select: simpleUserSelect },
    connections: {
      select: {
        model: {
          select: {
            id: true,
            name: true,
          },
        },
        reviewId: true,
      },
    },
    metrics: {
      where: {
        timeframe: MetricTimeframe.AllTime,
      },
      select: {
        likeCount: true,
        dislikeCount: true,
        laughCount: true,
        cryCount: true,
        heartCount: true,
        commentCount: true,
      },
    },
    reactions: !infinite
      ? {
          where: { userId: user?.id },
          take: !user?.id ? 0 : undefined,
          select: getReactionsSelect,
        }
      : undefined,
  });
