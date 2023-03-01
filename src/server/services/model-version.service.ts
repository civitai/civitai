import { dbWrite } from '~/server/db/client';
import { ModelVersionEngagementType, Prisma } from '@prisma/client';
import { SessionUser } from 'next-auth';
import { GetByIdInput } from '~/server/schema/base.schema';
import { ModelVersionUpsertInput } from '~/server/schema/model-version.schema';

export const getModelVersion = async <TSelect extends Prisma.ModelVersionSelect>({
  input: { id },
  user,  //eslint-disable-line
  select,
}: {
  input: GetByIdInput;
  user?: SessionUser;
  select: TSelect;
}) => {
  const model = await dbWrite.modelVersion.findUnique({ where: { id }, select });
  return model;
};

export const getModelVersionRunStrategies = async ({
  modelVersionId,
}: {
  modelVersionId: number;
}) =>
  dbWrite.runStrategy.findMany({
    where: { modelVersionId },
    select: {
      id: true,
      partnerId: true,
    },
  });

export const getVersionById = <TSelect extends Prisma.ModelVersionSelect>({
  id,
  select,
}: GetByIdInput & { select: TSelect }) => {
  return dbWrite.modelVersion.findUnique({ where: { id }, select });
};

export const toggleModelVersionEngagement = async ({
  userId,
  versionId,
  type,
}: {
  userId: number;
  versionId: number;
  type: ModelVersionEngagementType;
}) => {
  const engagement = await dbWrite.modelVersionEngagement.findUnique({
    where: { userId_modelVersionId: { userId, modelVersionId: versionId } },
    select: { type: true },
  });

  if (engagement) {
    if (engagement.type === type)
      await dbWrite.modelVersionEngagement.delete({
        where: { userId_modelVersionId: { userId, modelVersionId: versionId } },
      });
    else if (engagement.type !== type)
      await dbWrite.modelVersionEngagement.update({
        where: { userId_modelVersionId: { userId, modelVersionId: versionId } },
        data: { type },
      });

    return;
  }

  await dbWrite.modelVersionEngagement.create({
    data: { type, modelVersionId: versionId, userId },
  });
  return;
};

export const toggleNotifyModelVersion = ({ id, userId }: GetByIdInput & { userId: number }) => {
  return toggleModelVersionEngagement({ userId, versionId: id, type: 'Notify' });
};

export const upsertModelVersion = ({ id, ...data }: ModelVersionUpsertInput) => {
  return dbWrite.modelVersion.upsert({
    where: { id: id ?? -1 },
    create: { ...data },
    update: { ...data },
  });
};
