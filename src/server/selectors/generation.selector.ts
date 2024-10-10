import { Prisma } from '@prisma/client';

export const generationResourceSelect = Prisma.validator<Prisma.ModelVersionSelect>()({
  id: true,
  name: true,
  trainedWords: true,
  index: true,
  baseModel: true,
  baseModelType: true,
  settings: true,
  generationCoverage: { select: { covered: true } },
  availability: true,
  clipSkip: true,
  vaeId: true,
  model: {
    select: {
      id: true,
      name: true,
      type: true,
      nsfw: true,
      poi: true,
      minor: true,
      availability: true,
    },
  },
});
