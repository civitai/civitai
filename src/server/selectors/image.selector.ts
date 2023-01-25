import { simpleUserSelect } from './user.selector';
import { Prisma } from '@prisma/client';

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

export const imageGallerySelect = Prisma.validator<Prisma.ImageSelect>()({
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
});
