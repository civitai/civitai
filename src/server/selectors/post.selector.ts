import { ImageMetaProps } from '~/server/schema/image.schema';
import { simpleTagSelect, imageTagCompositeSelect } from './tag.selector';
import { Prisma } from '@prisma/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

export const editPostImageSelect = Prisma.validator<Prisma.ImageSelect>()({
  id: true,
  name: true,
  url: true,
  width: true,
  height: true,
  hash: true,
  meta: true,
  hideMeta: true,
  generationProcess: true,
  needsReview: true,
  mimeType: true,
  type: true,
  metadata: true,
  resourceHelper: true,
  ingestion: true,
  blockedFor: true,
  nsfwLevel: true,
  index: true,
});

type PostImageNavigationProps = { previewUrl?: string; objectUrl?: string };
export type PostImageEditSelect = Prisma.ImageGetPayload<typeof postImage>;
export type PostImageEditProps = Omit<PostImageEditSelect, 'meta'> &
  PostImageNavigationProps & { meta: ImageMetaProps | null };
const postImage = Prisma.validator<Prisma.ImageDefaultArgs>()({ select: editPostImageSelect });

export const editPostSelect = Prisma.validator<Prisma.PostSelect>()({
  id: true,
  nsfwLevel: true,
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

export const postSelect = Prisma.validator<Prisma.PostSelect>()({
  id: true,
  nsfwLevel: true,
  title: true,
  detail: true,
  modelVersionId: true,
  user: { select: userWithCosmeticsSelect },
  publishedAt: true,
  availability: true,
  tags: { select: { tag: { select: simpleTagSelect } } },
});

// export const postForHomePageSelector = Prisma.validator<Prisma.PostSelect>()({
//   id: true,
//   nsfwLevel: true,
//   title: true,
//   publishedAt: true,
//   stats: {
//     select: {
//       commentCountAllTime: true,
//       likeCountAllTime: true,
//       dislikeCountAllTime: true,
//       heartCountAllTime: true,
//       laughCountAllTime: true,
//       cryCountAllTime: true,
//     },
//   },
// });
