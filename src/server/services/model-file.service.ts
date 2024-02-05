import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { ModelFileCreateInput, ModelFileUpdateInput } from '~/server/schema/model-file.schema';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { prepareFile } from '~/utils/file-helpers';

export const getByVersionId = ({ modelVersionId }: { modelVersionId: number }) => {
  return dbRead.modelFile.findMany({ where: { modelVersionId } });
};

export async function createFile<TSelect extends Prisma.ModelFileSelect>({
  select,
  userId,
  isModerator,
  ...data
}: ModelFileCreateInput & { select: TSelect; userId: number; isModerator?: boolean }) {
  const file = prepareFile(data);

  const ownsVersion = await dbWrite.modelVersion.findFirst({
    where: { id: data.modelVersionId, model: !isModerator ? { userId } : undefined },
  });
  if (!ownsVersion) throw throwNotFoundError();

  return dbWrite.modelFile.create({
    data: { ...file, modelVersionId: data.modelVersionId },
    select,
  });
}

export async function updateFile({
  id,
  metadata,
  userId,
  ...inputData
}: ModelFileUpdateInput & { userId: number }) {
  const modelFile = await dbWrite.modelFile.findUnique({
    where: { id, modelVersion: { model: { userId } } },
    select: { id: true, metadata: true, modelVersionId: true },
  });
  if (!modelFile) throw throwNotFoundError();

  metadata = metadata ? { ...(modelFile.metadata as Prisma.JsonObject), ...metadata } : undefined;
  await dbWrite.modelFile.updateMany({
    where: { id },
    data: {
      ...inputData,
      metadata,
    },
  });

  return {
    ...modelFile,
    metadata,
  };
}

export async function deleteFile({ id, userId }: GetByIdInput & { userId: number }) {
  const rows = await dbWrite.$queryRaw<{ modelVersionId: number }[]>`
    DELETE FROM "ModelFile" mf
    USING "ModelVersion" mv, "Model" m
    WHERE mf."modelVersionId" = mv.id
    AND mv."modelId" = m.id
    AND mf.id = ${id}
    AND m."userId" = ${userId}
    RETURNING
      mv.id as "modelVersionId"
  `;

  return rows[0];
}
