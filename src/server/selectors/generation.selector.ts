import { Prisma } from '@prisma/client';

export const generationResourceSelect = Prisma.validator<Prisma.ModelVersionSelect>()({
  id: true,
  name: true,
  trainedWords: true,
  baseModel: true,
  settings: true,
  availability: true,
  clipSkip: true,
  vaeId: true,
  earlyAccessEndsAt: true,
  earlyAccessConfig: true,
  model: {
    select: {
      id: true,
      name: true,
      type: true,
      nsfw: true,
      poi: true,
      minor: true,
      sfwOnly: true,
      userId: true,
    },
  },
  generationCoverage: {
    select: {
      covered: true,
    },
  },
});
