import { SessionUser } from 'next-auth';
import { simpleUserSelect } from './user.selector';
import { Prisma, MetricTimeframe } from '@prisma/client';
import { getReactionsSelect } from '~/server/selectors/reaction.selector';

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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { id, name, ...imageSelectWithoutId } = imageSelect;
export { imageSelectWithoutId };

const image = Prisma.validator<Prisma.ImageArgs>()({ select: imageSelect });

export type ImageModel = Prisma.ImageGetPayload<typeof image>;

export const imageGallerySelect = ({
  period,
  user,
}: {
  period: MetricTimeframe;
  user?: SessionUser;
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
      },
    },
    reactions: {
      where: { userId: user?.id },
      take: !user?.id ? 0 : undefined,
      select: getReactionsSelect,
    },
  });
