import { Prisma } from '@prisma/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { imageTagSelect } from './tag.selector';

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
    // meta: true,
    hideMeta: true,
    createdAt: true,
    sortAt: true,
    mimeType: true,
    scannedAt: true,
    ingestion: true,
    blockedFor: true,
    type: true,
    metadata: true,
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
// AllTime image stat counts. Formerly a Prisma relation to the `ImageStat` view
// (which pivoted the retired PG `ImageMetric` table); the view is gone and these
// counts are now populated from ClickHouse (see `getImageMetricsObject` callers
// in image.service.ts). Kept as an explicit shape so the feed contract is stable.
export type ImageV2Stats = {
  cryCountAllTime: number;
  dislikeCountAllTime: number;
  heartCountAllTime: number;
  laughCountAllTime: number;
  likeCountAllTime: number;
  commentCountAllTime: number;
  collectedCountAllTime: number;
  tippedAmountCountAllTime: number;
  viewCountAllTime: number;
  /**
   * The ClickHouse read produced no row for this image, so every count above is a
   * placeholder rather than a measurement.
   *
   * One flag and not five nullable counts: `getImageMetricsObject` builds all seven
   * fields from a single row, so a count can never be unresolved on its own. A
   * per-count shape would be able to represent states the read cannot produce.
   */
  statsUnknown: boolean;
};
export type ImageV2Model = Omit<Prisma.ImageGetPayload<typeof imageV2Model>, 'meta'> &
  ImageV2NavigationProps & { postTitle: string | null; stats: ImageV2Stats };
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
