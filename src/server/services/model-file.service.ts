import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type {
  ModelFileCreateInput,
  ModelFileUpdateInput,
  RecentTrainingDataInput,
} from '~/server/schema/model-file.schema';
import { modelFileSelect } from '~/server/selectors/modelFile.selector';
import { createCachedObject } from '~/server/utils/cache-helpers';
import {
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { ModelStatus, ModelUploadType } from '~/shared/utils/prisma/enums';
import { prepareFile } from '~/utils/file-helpers';

export type ModelFileCached = AsyncReturnType<typeof fetchModelFilesForCache>[number];
async function fetchModelFilesForCache(ids: number[]) {
  return await dbRead.modelFile
    .findMany({
      where: { modelVersionId: { in: ids } },
      select: modelFileSelect,
    })
    .then((data) =>
      data.map(({ metadata, ...file }) => {
        return {
          ...file,
          // TODO: Confirm with Briant whether this can be removed or not. -> reduceToBasicFileMetadata(metadata),
          metadata: metadata as FileMetadata,
        };
      })
    );
}

export const filesForModelVersionCache = createCachedObject({
  key: REDIS_KEYS.CACHES.FILES_FOR_MODEL_VERSION,
  idKey: 'modelVersionId',
  ttl: CacheTTL.sm,
  async lookupFn(ids) {
    const files = await fetchModelFilesForCache(ids);

    const records: Record<number, { modelVersionId: number; files: typeof files }> = {};
    for (const file of files) {
      if (!records[file.modelVersionId])
        records[file.modelVersionId] = { modelVersionId: file.modelVersionId, files: [] };
      records[file.modelVersionId].files.push(file);
    }
    return records;
  },
});

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
    data: {
      ...file,
      rawScanResult: file.rawScanResult !== null ? file.rawScanResult : Prisma.JsonNull,
      modelVersionId: data.modelVersionId,
    },
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
  // Check if deleting a training file for a model still in draft/training state
  const file = await dbWrite.modelFile.findFirst({
    where: { id, modelVersion: { model: !isModerator ? { userId } : undefined } },
    select: {
      type: true,
      modelVersion: {
        select: {
          model: {
            select: { status: true },
          },
        },
      },
    },
  });

  if (!file) throw throwNotFoundError();

  const modelStatus = file.modelVersion.model.status;
  const isTrainingFile = file.type === 'Training Data';
  const isUnpublished = modelStatus === ModelStatus.Draft || modelStatus === ModelStatus.Training;

  if (isTrainingFile && isUnpublished) {
    throw throwBadRequestError(
      'Cannot delete training data for a model that is still in draft or training. ' +
        'This would prevent the model from being published.'
    );
  }

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

export const getRecentTrainingData = async ({
  userId,
  limit,
  cursor = 0,
  ...filters
}: RecentTrainingDataInput & { userId: number }) => {
  const where: Prisma.ModelFileWhereInput[] = [
    { type: 'Training Data' },
    { dataPurged: false },
    { modelVersion: { uploadType: ModelUploadType.Trained, model: { userId } } },
  ];

  if (filters.hasLabels === true || filters.labelType !== null) {
    where.push({ metadata: { path: ['numCaptions'], gt: 0 } });
  }
  if (filters.labelType !== null) {
    where.push({ metadata: { path: ['labelType'], equals: filters.labelType } });
  }
  if (filters.statuses?.length) {
    where.push({ modelVersion: { trainingStatus: { in: filters.statuses } } });
  }
  if (filters.mediaTypes?.length) {
    where.push({
      OR: [
        ...filters.mediaTypes.map((type) => ({
          modelVersion: { trainingDetails: { path: ['mediaType'], equals: type } },
        })),
        // { modelVersion: { trainingDetails: { path: ['mediaType'], equals: undefined } } },
      ],
    });
  }
  if (filters.types?.length) {
    where.push({
      OR: filters.types.map((type) => ({
        modelVersion: { trainingDetails: { path: ['type'], equals: type } },
      })),
    });
  }
  if (filters.baseModels?.length) {
    where.push({ modelVersion: { baseModel: { in: filters.baseModels } } });
  }

  try {
    const data = await dbWrite.modelFile.findMany({
      where: { AND: where },
      select: {
        id: true,
        metadata: true,
        url: true,
        sizeKB: true,
        createdAt: true,
        modelVersion: {
          select: {
            id: true,
            name: true,
            trainingStatus: true,
            trainingDetails: true,
            model: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { id: 'desc' },
    });

    let nextCursor: number | undefined;
    if (data.length > limit) {
      const nextItem = data.pop();
      nextCursor = nextItem?.id;
    }

    return {
      items: data,
      nextCursor,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
