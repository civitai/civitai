import { imageTagSelect } from './tag.selector';
import { Prisma } from '@prisma/client';
import { userWithCosmeticsSelect, simpleUserSelect } from '~/server/selectors/user.selector';
import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import { ImageMetaProps } from '~/server/schema/image.schema';

export const imageResourceSelect = Prisma.validator<Prisma.ImageResourceSelect>()({
  id: true,
  detected: true,
  modelVersion: {
    select: {
      id: true,
      name: true,
      model: {
        select: {
          id: true,
          name: true,
          type: true,
          user: {
            select: userWithCosmeticsSelect,
          },
        },
      },
    },
  },
});

type GetSelectArgs = { userId?: number };
export const getImageV2Select = ({ userId }: GetSelectArgs) =>
  Prisma.validator<Prisma.ImageSelect>()({
    id: true,
    index: true,
    postId: true,
    name: true,
    url: true,
    nsfwLevel: true,
    width: true,
    height: true,
    hash: true,
    meta: true,
    hideMeta: true,
    generationProcess: true,
    createdAt: true,
    mimeType: true,
    scannedAt: true,
    ingestion: true,
    type: true,
    metadata: true,
    stats: {
      select: {
        cryCountAllTime: true,
        dislikeCountAllTime: true,
        heartCountAllTime: true,
        laughCountAllTime: true,
        likeCountAllTime: true,
        commentCountAllTime: true,
        collectedCountAllTime: true,
        tippedAmountCountAllTime: true,
        viewCountAllTime: true,
      },
    },
    reactions: {
      where: { userId },
      take: !userId ? 0 : undefined,
      select: {
        userId: true,
        reaction: true,
      },
    },
    user: { select: userWithCosmeticsSelect },
    needsReview: true,
  });

type ImageV2NavigationProps = { previewUrl?: string };
export type ImageV2Model = Omit<Prisma.ImageGetPayload<typeof imageV2Model>, 'meta'> &
  ImageV2NavigationProps & { postTitle: string | null; meta: ImageMetaProps | null };
const imageV2Model = Prisma.validator<Prisma.ImageDefaultArgs>()({ select: getImageV2Select({}) });

export const imageV2DetailSelect = Prisma.validator<Prisma.ImageSelect>()({
  id: true,
  tags: {
    select: {
      tag: {
        select: imageTagSelect,
      },
    },
  },
  user: { select: userWithCosmeticsSelect },
  resources: { select: imageResourceSelect },
});
export type ImageV2DetailsModel = Prisma.ImageGetPayload<typeof imageV2DetailModel>;
const imageV2DetailModel = Prisma.validator<Prisma.ImageDefaultArgs>()({
  select: imageV2DetailSelect,
});
