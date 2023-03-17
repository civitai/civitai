import { ModelVersionEngagementType, Prisma } from '@prisma/client';

import { GetByIdInput } from '~/server/schema/base.schema';
import { dbWrite, dbRead } from '~/server/db/client';
import { ModelVersionUpsertInput } from '~/server/schema/model-version.schema';

export const getModelVersionRunStrategies = async ({
  modelVersionId,
}: {
  modelVersionId: number;
}) =>
  dbRead.runStrategy.findMany({
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
  return dbRead.modelVersion.findUnique({ where: { id }, select });
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

export const upsertModelVersion = async ({ id, modelId, ...data }: ModelVersionUpsertInput) => {
  if (!id) {
    // if it's a new version, we set it at the top of the list
    // and increment the index of all other versions
    const existingVersions = await dbRead.modelVersion.findMany({ where: { modelId } });

    const currentVersionIndex = existingVersions.length > 0 ? existingVersions[0].index ?? -1 : -1;
    const newVersionIndex = currentVersionIndex + 1;

    const updatedVersions = existingVersions.map((version) => {
      const parsedIndex = Number(version.index);

      if (parsedIndex === 0) {
        return { ...version, index: newVersionIndex };
      } else if (parsedIndex >= newVersionIndex) {
        return { ...version, index: parsedIndex + 1 };
      } else {
        return version;
      }
    });

    const [version] = await dbWrite.$transaction([
      // create the new version
      dbWrite.modelVersion.create({
        data: {
          ...data,
          index: 0,
          modelId,
        },
      }),
      // update the index of all other versions
      ...updatedVersions.map(({ id, index }) =>
        dbWrite.modelVersion.update({
          where: { id },
          data: { index: index as number },
        })
      ),
    ]);

    return version;
  }

  // Otherwise, we just update the version
  return dbWrite.modelVersion.update({
    where: { id },
    data,
  });
};

export const deleteVersionById = async ({ id }: GetByIdInput) => {
  return dbWrite.modelVersion.delete({ where: { id } });
};
