import { Prisma } from '@prisma/client';

export const modelHashSelect = Prisma.validator<Prisma.ModelHashSelect>()({
  modelVersionId: true,
  hash: true,
  hashType: true,
});

const modelHash = Prisma.validator<Prisma.ModelHashArgs>()({
  select: modelHashSelect,
});
export type ModelHashModel = Prisma.ModelHashGetPayload<typeof modelHash>;
