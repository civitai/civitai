import { simpleTagSelect, imageTagCompositeSelect } from './tag.selector';
import { Prisma } from '@prisma/client';

export const editPostImageSelect = Prisma.validator<Prisma.ImageSelect>()({
  id: true,
  name: true,
  url: true,
  nsfw: true,
  width: true,
  height: true,
  hash: true,
  meta: true,
  hideMeta: true,
  generationProcess: true,
  needsReview: true,
  mimeType: true,
  resourceHelper: true,
  ingestion: true,
  blockedFor: true,
  // tagComposites: {
  //   where: { OR: [{ score: { gt: 0 } }, { tagType: 'Moderation' }] },
  //   select: imageTagCompositeSelect,
  //   orderBy: { score: 'desc' },
  // },
});
type PostImageNavigationProps = { previewUrl?: string };
export type PostImage = Prisma.ImageGetPayload<typeof postImage> &
  PostImageNavigationProps & { _count: { tags: number } };
const postImage = Prisma.validator<Prisma.ImageArgs>()({ select: editPostImageSelect });

export const editPostSelect = Prisma.validator<Prisma.PostSelect>()({
  id: true,
  nsfw: true,
  title: true,
  detail: true,
  modelVersionId: true,
  userId: true,
  publishedAt: true,
  images: {
    orderBy: { index: 'asc' },
    select: editPostImageSelect,
  },
  tags: { select: { tag: { select: simpleTagSelect } } },
});

export const postForHomePageSelector = Prisma.validator<Prisma.PostSelect>()({
  id: true,
  nsfw: true,
  title: true,
  publishedAt: true,
  stats: {
    select: {
      commentCountAllTime: true,
      likeCountAllTime: true,
      dislikeCountAllTime: true,
      heartCountAllTime: true,
      laughCountAllTime: true,
      cryCountAllTime: true,
    },
  },
});
