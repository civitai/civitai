import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { filesForModelVersionCache } from '~/server/redis/caches';
import { GetByIdInput } from '~/server/schema/base.schema';
import { ModelFileCreateInput, ModelFileUpdateInput } from '~/server/schema/model-file.schema';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { prepareFile } from '~/utils/file-helpers';

export function reduceToBasicFileMetadata(
  metadataRaw: Prisma.JsonValue | BasicFileMetadata
): BasicFileMetadata {
  if (typeof metadataRaw !== 'object') return {};
  const { format, size, fp } = metadataRaw as BasicFileMetadata;
  return {
    format,
    size,
    fp,
  };
}

export async function getFilesForModelVersionCache(modelVersionIds: number[]) {
  return await filesForModelVersionCache.fetch(modelVersionIds);
}
export async function deleteFilesForModelVersionCache(modelVersionId: number) {
  await filesForModelVersionCache.bust(modelVersionId);
}

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

  const result = await dbWrite.modelFile.create({
    data: { ...file, modelVersionId: data.modelVersionId },
    select,
  });
  await deleteFilesForModelVersionCache(data.modelVersionId);

  return result;
}

export async function updateFile({
  id,
  metadata,
  userId,
  isModerator,
  ...inputData
}: ModelFileUpdateInput & { userId: number; isModerator?: boolean }) {
  const modelFile = await dbWrite.modelFile.findUnique({
    where: { id, modelVersion: { model: !isModerator ? { userId } : undefined } },
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
  await deleteFilesForModelVersionCache(modelFile.modelVersionId);

  return {
    ...modelFile,
    metadata,
  };
}

export async function deleteFile({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId: number; isModerator?: boolean }) {
  const rows = await dbWrite.$queryRaw<{ modelVersionId: number }[]>`
    DELETE FROM "ModelFile" mf
    USING "ModelVersion" mv, "Model" m
    WHERE mf."modelVersionId" = mv.id
    AND mv."modelId" = m.id
    AND mf.id = ${id}
    ${isModerator ? Prisma.empty : Prisma.raw(`AND m."userId" = ${userId}`)}
    RETURNING
      mv.id as "modelVersionId"
  `;

  const modelVersionId = rows[0]?.modelVersionId;
  if (modelVersionId) await deleteFilesForModelVersionCache(modelVersionId);

  return modelVersionId;
}
