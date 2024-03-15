import { Prisma } from '@prisma/client';
import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { ModelFileCreateInput, ModelFileUpdateInput } from '~/server/schema/model-file.schema';
import { ModelFileModel, modelFileSelect } from '~/server/selectors/modelFile.selector';
import { bustCachedArray, cachedObject } from '~/server/utils/cache-helpers';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { prepareFile } from '~/utils/file-helpers';

export const getFilesByVersionIds = ({ ids }: { ids: number[] }) => {
  return dbRead.modelFile.findMany({
    where: { modelVersionId: { in: ids } },
    select: modelFileSelect,
  });
};

type CacheFilesForModelVersions = {
  modelVersionId: number;
  files: ModelFileModel[];
};
export async function getFilesForModelVersionCache(modelVersionIds: number[]) {
  return await cachedObject<CacheFilesForModelVersions>({
    key: REDIS_KEYS.CACHES.FILES_FOR_MODEL_VERSION,
    idKey: 'modelVersionId',
    ids: modelVersionIds,
    ttl: CacheTTL.sm,
    lookupFn: async (ids) => {
      const files = await getFilesByVersionIds({ ids });

      const records: Record<number, CacheFilesForModelVersions> = {};
      for (const file of files) {
        if (!records[file.modelVersionId])
          records[file.modelVersionId] = { modelVersionId: file.modelVersionId, files: [] };
        records[file.modelVersionId].files.push(file);
      }
      return records;
    },
  });
}

export async function deleteFilesForModelVersionCache(modelVersionId: number) {
  await bustCachedArray(
    REDIS_KEYS.CACHES.FILES_FOR_MODEL_VERSION,
    'modelVersionId',
    modelVersionId
  );
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
