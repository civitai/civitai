import { Prisma } from '@prisma/client';

export const modelHashSelect = Prisma.validator<Prisma.ModelHashSelect>()({
  hash: true,
});

const modelHash = Prisma.validator<Prisma.ModelHashArgs>()({
  select: modelHashSelect,
});
export type ModelHashModel = Prisma.ModelHashGetPayload<typeof modelHash>;
