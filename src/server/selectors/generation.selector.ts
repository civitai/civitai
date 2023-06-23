import { Prisma } from '@prisma/client';

export const generationResourceSelect = Prisma.validator<Prisma.ModelVersionSelect>()({
  id: true,
  name: true,
  trainedWords: true,
  index: true,
  modelVersionGenerationCoverage: {
    select: {
      serviceProviders: true,
    },
  },
  model: {
    select: {
      id: true,
      name: true,
      type: true,
      nsfw: true,
    },
  },
});
