import { prisma } from '~/server/db/client';
import { Prisma } from '@prisma/client';
import { SessionUser } from 'next-auth';
import { GetByIdInput } from '~/server/schema/base.schema';

export const getModelVersion = async <TSelect extends Prisma.ModelVersionSelect>({
  input: { id },
  user,
  select,
}: {
  input: GetByIdInput;
  user?: SessionUser;
  select: TSelect;
}) => {
  const model = await prisma.modelVersion.findUnique({ where: { id }, select });
  return model;
};

export const getModelVersionRunStrategies = async ({
  modelVersionId,
}: {
  modelVersionId: number;
}) =>
  prisma.runStrategy.findMany({
    where: { modelVersionId },
    select: {
      id: true,
      partnerId: true,
    },
  });
