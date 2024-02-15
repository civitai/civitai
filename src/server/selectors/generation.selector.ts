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
  model: {
    select: {
      id: true,
      name: true,
      type: true,
      nsfw: true,
      poi: true,
    },
  },
});

const generationResource = Prisma.validator<Prisma.ModelVersionArgs>()({
  select: generationResourceSelect,
});
export type GenerationResourceSelect = Prisma.ModelVersionGetPayload<typeof generationResource>;
