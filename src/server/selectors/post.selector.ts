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
  tools: {
    select: {
      notes: true,
      tool: {
        select: {
          id: true,
          name: true,
          icon: true,
        },
      },
    },
  },
});

type PostImageNavigationProps = { previewUrl?: string; objectUrl?: string };
export type PostImageEditSelect = Prisma.ImageGetPayload<typeof postImage>;
export type PostImageEditProps = Omit<PostImageEditSelect, 'meta'> &
  PostImageNavigationProps & { meta: ImageMetaProps | null };
const postImage = Prisma.validator<Prisma.ImageDefaultArgs>()({ select: editPostImageSelect });

export const postSelect = Prisma.validator<Prisma.PostSelect>()({
  id: true,
  nsfwLevel: true,
  title: true,
  detail: true,
  modelVersionId: true,
  modelVersion: { where: { publishedAt: { not: null } }, select: { id: true } },
  user: { select: userWithCosmeticsSelect },
  publishedAt: true,
  availability: true,
  tags: { select: { tag: { select: simpleTagSelect } } },
});
