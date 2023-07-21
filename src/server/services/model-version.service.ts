import { ModelStatus, ModelVersionEngagementType, Prisma } from '@prisma/client';

import { GetByIdInput } from '~/server/schema/base.schema';
import { dbWrite, dbRead } from '~/server/db/client';
import {
  DeleteExplorationPromptInput,
  ModelVersionMeta,
  ModelVersionUpsertInput,
  PublishVersionInput,
  UpsertExplorationPromptInput,
  GetModelVersionByModelTypeProps,
} from '~/server/schema/model-version.schema';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { TRPCError } from '@trpc/server';
import { ModelMeta, UnpublishModelSchema } from '~/server/schema/model.schema';
import { SessionUser } from 'next-auth';
import { baseModelSets, BaseModel } from '~/server/common/constants';

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

export const getDefaultModelVersion = async ({
  modelId,
  modelVersionId,
}: {
  modelId: number;
  modelVersionId?: number;
}) => {
  const result = await dbRead.model.findUnique({
    where: { id: modelId },
    select: {
      modelVersions: {
        take: 1,
        where: modelVersionId ? { id: modelVersionId } : undefined,
        orderBy: { index: 'asc' },
        select: { id: true, status: true, model: { select: { userId: true } } },
      },
    },
  });
  if (!result) throw throwNotFoundError();
  return result.modelVersions[0];
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

export const upsertModelVersion = async (
  data: ModelVersionUpsertInput & { meta?: Prisma.ModelVersionCreateInput['meta'] }
) => {
  if (!data.id) {
    const existingVersions = await dbRead.modelVersion.findMany({
      where: { modelId: data.modelId },
      select: { id: true },
      orderBy: { index: 'asc' },
    });
    const [version] = await dbWrite.$transaction([
      dbWrite.modelVersion.create({
        data: {
          ...data,
          index: 0,
        },
      }),
      ...existingVersions.map(({ id }, index) =>
        dbWrite.modelVersion.update({ where: { id }, data: { index: index + 1 } })
      ),
    ]);
    return version;
  } else {
    console.log({ data });
    const version = await dbWrite.modelVersion.update({
      where: { id: data.id },
      data,
    });

    return version;
  }

  // if (!id) {
  //   // if it's a new version, we set it at the top of the list
  //   // and increment the index of all other versions
  //   const existingVersions = await dbRead.modelVersion.findMany({ where: { modelId } });

  //   const currentVersionIndex = existingVersions.length > 0 ? existingVersions[0].index ?? -1 : -1;
  //   const newVersionIndex = currentVersionIndex + 1;

  //   const updatedVersions = existingVersions.map((version) => {
  //     const parsedIndex = Number(version.index);

  //     if (parsedIndex === 0) {
  //       return { ...version, index: newVersionIndex };
  //     } else if (parsedIndex >= newVersionIndex) {
  //       return { ...version, index: parsedIndex + 1 };
  //     } else {
  //       return version;
  //     }
  //   });

  //   const [version] = await dbWrite.$transaction([
  //     // create the new version
  //     dbWrite.modelVersion.create({
  //       data: {
  //         ...data,
  //         index: 0,
  //         modelId,
  //       },
  //     }),
  //     // update the index of all other versions
  //     ...updatedVersions.map(({ id, index }) =>
  //       dbWrite.modelVersion.update({
  //         where: { id },
  //         data: { index: index as number },
  //       })
  //     ),
  //   ]);

  //   return version;
  // }

  // // Otherwise, we just update the version
  // const version = await dbWrite.modelVersion.update({
  //   where: { id },
  //   data,
  // });

  // return version;
};

export const deleteVersionById = async ({ id }: GetByIdInput) => {
  return dbWrite.modelVersion.delete({ where: { id } });
};

export const updateModelVersionById = ({
  id,
  data,
}: GetByIdInput & { data: Prisma.ModelVersionUpdateInput }) => {
  return dbWrite.modelVersion.update({ where: { id }, data });
};

export const publishModelVersionById = async ({
  id,
  publishedAt,
  meta,
}: PublishVersionInput & { meta?: ModelVersionMeta }) => {
  let status: ModelStatus = ModelStatus.Published;
  if (publishedAt && publishedAt > new Date()) status = ModelStatus.Scheduled;
  else publishedAt = new Date();

  const version = await dbWrite.modelVersion.update({
    where: { id },
    data: {
      status,
      publishedAt,
      meta,
      model:
        status !== ModelStatus.Scheduled ? { update: { lastVersionAt: publishedAt } } : undefined,
      posts:
        status !== ModelStatus.Scheduled
          ? { updateMany: { where: { publishedAt: null }, data: { publishedAt } } }
          : undefined,
    },
    select: {
      id: true,
      modelId: true,
      model: { select: { userId: true, id: true, type: true, nsfw: true } },
    },
  });

  // const { model } = version;
  // await playfab.trackEvent(model.userId, {
  //   eventName: 'user_update_model',
  //   modelId: model.id,
  //   type: model.type,
  // });

  return version;
};

export const unpublishModelVersionById = async ({
  id,
  reason,
  customMessage,
  meta,
  user,
}: UnpublishModelSchema & { meta?: ModelMeta; user: SessionUser }) => {
  const version = await dbWrite.$transaction(
    async (tx) => {
      const updatedVersion = await tx.modelVersion.update({
        where: { id },
        data: {
          status: reason ? ModelStatus.UnpublishedViolation : ModelStatus.Unpublished,
          publishedAt: null,
          meta: {
            ...meta,
            ...(reason
              ? {
                  unpublishedReason: reason,
                  customMessage,
                }
              : {}),
            unpublishedAt: new Date().toISOString(),
            unpublishedBy: user.id,
          },
        },
        select: { id: true, model: { select: { id: true, userId: true, nsfw: true } } },
      });

      await tx.post.updateMany({
        where: {
          modelVersionId: updatedVersion.id,
          userId: updatedVersion.model.userId,
          publishedAt: { not: null },
        },
        data: { publishedAt: null },
      });

      return updatedVersion;
    },
    { timeout: 10000 }
  );

  return version;
};

export const getExplorationPromptsById = async ({ id }: GetByIdInput) => {
  try {
    const prompts = await dbRead.modelVersionExploration.findMany({
      where: { modelVersionId: id },
      select: { name: true, prompt: true, index: true, modelVersionId: true },
    });

    return prompts;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertExplorationPrompt = async ({
  id: modelVersionId,
  name,
  index,
  prompt,
}: UpsertExplorationPromptInput) => {
  try {
    const explorationPrompt = await dbWrite.modelVersionExploration.upsert({
      where: { modelVersionId_name: { modelVersionId, name } },
      create: { modelVersionId, name, prompt, index: index ?? 0 },
      update: { index, prompt },
    });
    if (!explorationPrompt)
      throw throwNotFoundError(`No prompt with name ${name} belongs to version ${modelVersionId}`);

    return explorationPrompt;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const deleteExplorationPrompt = async ({
  name,
  id: modelVersionId,
}: DeleteExplorationPromptInput) => {
  try {
    const deleted = await dbWrite.modelVersionExploration.delete({
      where: { modelVersionId_name: { modelVersionId, name } },
    });
    if (!deleted)
      throw throwNotFoundError(`No prompt with name ${name} belongs to version ${modelVersionId}`);

    return deleted;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

const baseModelSetsArray = Object.values(baseModelSets);
export const getModelVersionsByModelType = async ({
  type,
  query,
  baseModel,
  take,
}: GetModelVersionByModelTypeProps) => {
  const sqlAnd = [Prisma.sql`mv.status = 'Published' AND m.type = ${type}::"ModelType"`];
  if (baseModel) {
    const baseModelSet = baseModelSetsArray.find((x) => x.includes(baseModel as BaseModel));
    if (baseModelSet)
      sqlAnd.push(Prisma.sql`mv."baseModel" IN (${Prisma.join(baseModelSet, ',')})`);
  }
  if (query) {
    const pgQuery = '%' + query + '%';
    sqlAnd.push(Prisma.sql`m.name ILIKE ${pgQuery}`);
  }

  const results = await dbRead.$queryRaw<Array<{ id: number; name: string; modelName: string }>>`
    SELECT
      mv.id,
      mv.name,
      m.name "modelName"
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE ${Prisma.join(sqlAnd, ' AND ')}
    ORDER BY m.name
    LIMIT ${take}
  `;

  return results;
};
