import { Prisma } from '@prisma/client';

export const simpleTagSelect = Prisma.validator<Prisma.TagSelect>()({
  id: true,
  name: true,
  isCategory: true,
});

const simpleTag = Prisma.validator<Prisma.TagArgs>()({
  select: simpleTagSelect,
});

export type SimpleTag = Prisma.TagGetPayload<typeof simpleTag>;
