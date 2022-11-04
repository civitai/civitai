import { Prisma } from '@prisma/client';
import { imageDetailsSelect, imageSimpleSelect } from '~/server/validators/image/selectors';

export const modelWithDetailsSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  description: true,
  trainedWords: true,
  nsfw: true,
  type: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      username: true,
    },
  },
  modelVersions: {
    select: {
      id: true,
      name: true,
      description: true,
      steps: true,
      epochs: true,
      trainingDataUrl: true,
      url: true,
      sizeKB: true,
      createdAt: true,
      updatedAt: true,
      images: {
        orderBy: {
          index: 'asc',
        },
        select: {
          index: true,
          image: {
            select: imageDetailsSelect,
          },
        },
      },
    },
  },
  reviews: {
    select: {
      text: true,
      rating: true,
      user: true,
      nsfw: true,
      createdAt: true,
      modelVersion: { select: { id: true, name: true } },
      imagesOnReviews: { select: { image: { select: imageSimpleSelect } } },
    },
  },
  tagsOnModels: { select: { tag: true } },
  rank: true,
});

const modelWithDetails = Prisma.validator<Prisma.ModelArgs>()({
  select: modelWithDetailsSelect,
});

export type ModelWithDetails = Prisma.ModelGetPayload<typeof modelWithDetails>;
