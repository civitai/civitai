import { Prisma } from '@prisma/client';

export const generationResourceSelect = Prisma.validator<Prisma.ModelVersionSelect>()({
  id: true,
  name: true,
  trainedWords: true,
  index: true,
  model: {
    select: {
      id: true,
      name: true,
      type: true,
      nsfw: true,
    },
  },
});
