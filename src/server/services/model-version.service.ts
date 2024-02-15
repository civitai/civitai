import {
  ModelStatus,
  ModelVersionEngagementType,
  Prisma,
  SearchIndexUpdateQueueAction,
} from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { SessionUser } from 'next-auth';
import { BaseModel, baseModelSets, constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';

import { GetByIdInput } from '~/server/schema/base.schema';
import {
  DeleteExplorationPromptInput,
  EarlyAccessModelVersionsOnTimeframeSchema,
  GetModelVersionByModelTypeProps,
  ModelVersionMeta,
  ModelVersionUpsertInput,
  ModelVersionsGeneratedImagesOnTimeframeSchema,
  PublishVersionInput,
  UpsertExplorationPromptInput,
} from '~/server/schema/model-version.schema';
import { ModelMeta, UnpublishModelSchema } from '~/server/schema/model.schema';
import {
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { updateModelLastVersionAt } from './model.service';
import { prepareModelInOrchestrator } from './generation/generation.service';
import { isDefined } from '~/utils/type-guards';
import { modelsSearchIndex } from '~/server/search-index';
import { getDbWithoutLag, preventReplicationLag } from '~/server/db/db-helpers';
import dayjs from 'dayjs';
import { clickhouse } from '~/server/clickhouse/client';
import { maxDate } from '~/utils/date-helpers';

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

export const getVersionById = async <TSelect extends Prisma.ModelVersionSelect>({
  id,
  select,
}: GetByIdInput & { select: TSelect }) => {
  const db = await getDbWithoutLag('modelVersion', id);
  const result = await db.modelVersion.findUnique({ where: { id }, select });
  return result;
};

export const getDefaultModelVersion = async ({
  modelId,
  modelVersionId,
}: {
  modelId: number;
  modelVersionId?: number;
}) => {
  const db = await getDbWithoutLag('model', modelId);
  const result = await db.model.findUnique({
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

export const upsertModelVersion = async ({
  id,
  monetization,
  settings,
  recommendedResources,
  templateId,
  ...data
}: Omit<ModelVersionUpsertInput, 'trainingDetails'> & {
  meta?: Prisma.ModelVersionCreateInput['meta'];
  trainingDetails?: Prisma.ModelVersionCreateInput['trainingDetails'];
}) => {
  // const model = await dbWrite.model.findUniqueOrThrow({ where: { id: data.modelId } });

  if (!id || templateId) {
    const existingVersions = await dbRead.modelVersion.findMany({
      where: { modelId: data.modelId },
      select: { id: true },
      orderBy: { index: 'asc' },
    });

    const [version] = await dbWrite.$transaction([
      dbWrite.modelVersion.create({
        data: {
          ...data,
          settings: settings !== null ? settings : Prisma.JsonNull,
          monetization:
            monetization && monetization.type
              ? {
                  create: {
                    type: monetization.type,
                    unitAmount: monetization.unitAmount,
                    currency: constants.defaultCurrency,
                    sponsorshipSettings: monetization.sponsorshipSettings
                      ? {
                          create: {
                            type: monetization.sponsorshipSettings?.type,
                            currency: constants.defaultCurrency,
                            unitAmount: monetization?.sponsorshipSettings?.unitAmount,
                          },
                        }
                      : undefined,
                  },
                }
              : undefined,
          index: 0,
          recommendedResources: recommendedResources
            ? {
                createMany: {
                  data: recommendedResources?.map((resource) => ({
                    resourceId: resource.resourceId,
                    settings: resource.settings !== null ? resource.settings : Prisma.JsonNull,
                  })),
                },
              }
            : undefined,
        },
      }),
      ...existingVersions.map(({ id }, index) =>
        dbWrite.modelVersion.update({ where: { id }, data: { index: index + 1 } })
      ),
    ]);
    await preventReplicationLag('modelVersion', version.id);

    return version;
  } else {
    const existingVersion = await dbRead.modelVersion.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        status: true,

        earlyAccessTimeFrame: true,
        monetization: {
          select: {
            id: true,
            type: true,
            unitAmount: true,
            sponsorshipSettings: {
              select: {
                id: true,
              },
            },
          },
        },
      },
    });

    if (
      existingVersion.status === ModelStatus.Published &&
      data.earlyAccessTimeFrame &&
      existingVersion.earlyAccessTimeFrame === 0
    ) {
      throw throwBadRequestError(
        'You cannot add early access on a model after it has been published.'
      );
    }

    if (
      existingVersion.status === ModelStatus.Published &&
      data.earlyAccessTimeFrame &&
      existingVersion.earlyAccessTimeFrame > 0 &&
      data.earlyAccessTimeFrame > existingVersion.earlyAccessTimeFrame
    ) {
      throw throwBadRequestError(
        'You cannot increase the early access time frame for a published early access model version.'
      );
    }

    const version = await dbWrite.modelVersion.update({
      where: { id },
      data: {
        ...data,
        settings: settings !== null ? settings : Prisma.JsonNull,
        monetization:
          existingVersion.monetization?.id && !monetization
            ? { delete: true }
            : monetization && monetization.type
            ? {
                upsert: {
                  create: {
                    type: monetization.type,
                    unitAmount: monetization.unitAmount,
                    currency: constants.defaultCurrency,
                    sponsorshipSettings: monetization.sponsorshipSettings
                      ? {
                          create: {
                            type: monetization.sponsorshipSettings?.type,
                            currency: constants.defaultCurrency,
                            unitAmount: monetization?.sponsorshipSettings?.unitAmount,
                          },
                        }
                      : undefined,
                  },
                  update: {
                    type: monetization.type,
                    unitAmount: monetization.unitAmount,
                    currency: constants.defaultCurrency,
                    sponsorshipSettings:
                      existingVersion.monetization?.sponsorshipSettings &&
                      !monetization.sponsorshipSettings
                        ? { delete: true }
                        : monetization.sponsorshipSettings
                        ? {
                            upsert: {
                              create: {
                                type: monetization.sponsorshipSettings?.type,
                                currency: constants.defaultCurrency,
                                unitAmount: monetization?.sponsorshipSettings?.unitAmount,
                              },
                              update: {
                                type: monetization.sponsorshipSettings?.type,
                                currency: constants.defaultCurrency,
                                unitAmount: monetization?.sponsorshipSettings?.unitAmount,
                              },
                            },
                          }
                        : undefined,
                  },
                },
              }
            : undefined,
        recommendedResources: recommendedResources
          ? {
              deleteMany: {
                id: {
                  notIn: recommendedResources.map((resource) => resource.id).filter(isDefined),
                },
              },
              createMany: {
                data: recommendedResources
                  .filter((resource) => !resource.id)
                  .map((resource) => ({
                    resourceId: resource.resourceId,
                    settings: resource.settings !== null ? resource.settings : Prisma.JsonNull,
                  })),
              },
              update: recommendedResources
                .filter((resource) => resource.id)
                .map((resource) => ({
                  where: { id: resource.id },
                  data: {
                    settings: resource.settings !== null ? resource.settings : Prisma.JsonNull,
                  },
                })),
            }
          : undefined,
      },
    });
    await preventReplicationLag('modelVersion', version.id);

    return version;
  }
};

export const deleteVersionById = async ({ id }: GetByIdInput) => {
  const version = await dbWrite.$transaction(async (tx) => {
    const deleted = await tx.modelVersion.delete({ where: { id } });
    await updateModelLastVersionAt({ id: deleted.modelId, tx });
    await preventReplicationLag('modelVersion', deleted.modelId);

    return deleted;
  });

  return version;
};

export const updateModelVersionById = async ({
  id,
  data,
}: GetByIdInput & { data: Prisma.ModelVersionUpdateInput }) => {
  const result = await dbWrite.modelVersion.update({ where: { id }, data });
  await preventReplicationLag('model', result.modelId);
  await preventReplicationLag('modelVersion', id);
};

export const publishModelVersionById = async ({
  id,
  publishedAt,
  meta,
  republishing,
}: PublishVersionInput & { meta?: ModelVersionMeta; republishing?: boolean }) => {
  let status: ModelStatus = ModelStatus.Published;
  if (publishedAt && publishedAt > new Date()) status = ModelStatus.Scheduled;
  else publishedAt = new Date();

  const version = await dbWrite.modelVersion.update({
    where: { id },
    data: {
      status,
      publishedAt: !republishing ? publishedAt : undefined,
      meta,
      posts:
        status !== ModelStatus.Scheduled
          ? { updateMany: { where: { publishedAt: null }, data: { publishedAt } } }
          : undefined,
    },
    select: {
      id: true,
      modelId: true,
      baseModel: true,
      model: { select: { userId: true, id: true, type: true, nsfw: true } },
    },
  });

  if (!republishing && !meta?.unpublishedBy)
    await updateModelLastVersionAt({ id: version.modelId });
  await prepareModelInOrchestrator({ id: version.id, baseModel: version.baseModel });
  await preventReplicationLag('model', version.modelId);
  await preventReplicationLag('modelVersion', id);

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

      await preventReplicationLag('model', updatedVersion.model.id);
      await preventReplicationLag('modelVersion', updatedVersion.id);

      return updatedVersion;
    },
    { timeout: 10000 }
  );

  await modelsSearchIndex.queueUpdate([
    { id: version.model.id, action: SearchIndexUpdateQueueAction.Update },
  ]);
  await updateModelLastVersionAt({ id: version.model.id });

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

export const earlyAccessModelVersionsOnTimeframe = async ({
  userId,
  // Timeframe is on days
  timeframe = 14,
}: EarlyAccessModelVersionsOnTimeframeSchema & {
  userId: number;
}) => {
  type ModelVersionForEarlyAccess = {
    id: number;
    modelId: number;
    createdAt: Date;
    publishedAt: Date;
    earlyAccessTimeFrame: number;
    meta: ModelVersionMeta;
    modelName: string;
    modelVersionName: string;
    userId: number;
  };

  const modelVersions = await dbRead.$queryRaw<ModelVersionForEarlyAccess[]>`
    SELECT
      mv.id,
      mv."modelId",
      mv."createdAt",
      mv."publishedAt",
      mv."earlyAccessTimeFrame",
      mv."meta",
      m.name as "modelName",
      mv.name as "modelVersionName",
      m."userId"
    FROM "ModelVersion" mv
    JOIN "Model" m ON mv."modelId" = m.id
    WHERE mv."status" = 'Published'
      AND mv."earlyAccessTimeFrame" > 0
      AND m."userId" = ${userId}
      AND GREATEST(mv."createdAt", mv."publishedAt") 
        + (mv."earlyAccessTimeFrame" || ' day')::INTERVAL
        >= ${dayjs().subtract(timeframe, 'day').toDate()};
  `;

  return modelVersions;
};

export const modelVersionGeneratedImagesOnTimeframe = async ({
  userId,
  // Timeframe is on days
  timeframe = 31,
}: ModelVersionsGeneratedImagesOnTimeframeSchema & {
  userId: number;
}) => {
  type ModelVersionForGeneratedImages = {
    id: number;
    modelName: string;
    modelVersionName: string;
    userId: number;
  };

  const modelVersions = await dbRead.$queryRaw<ModelVersionForGeneratedImages[]>`
      SELECT
        mv.id,
        m."userId",
        m.name as "modelName",
        mv.name as "modelVersionName"
      FROM "ModelVersion" mv
      JOIN "Model" m ON mv."modelId" = m.id
      WHERE mv."status" = 'Published' 
        AND m."userId" = ${userId}
    `;

  if (!clickhouse || modelVersions.length === 0) return [];

  const date = maxDate(
    dayjs().startOf('day').subtract(timeframe, 'day').toDate(),
    dayjs().startOf('month').subtract(1, 'day').toDate()
  ).toISOString();

  const generationData = await clickhouse
    .query({
      query: `
          SELECT 
              resourceId as modelVersionId,
              createdAt,
              SUM(1) as generations
          FROM (
              SELECT 
                  arrayJoin(resourcesUsed) as resourceId,
                  createdAt::date as createdAt 
              FROM orchestration.textToImageJobs
              WHERE createdAt >= parseDateTimeBestEffortOrNull('${date}')
          )
          WHERE resourceId IN (${modelVersions.map((x) => x.id).join(',')})
          GROUP BY resourceId, createdAt 
          ORDER BY createdAt DESC, generations DESC;
    `,
      format: 'JSONEachRow',
    })
    .then((x) => x.json<{ modelVersionId: number; createdAt: Date; generations: number }[]>());

  const versions = modelVersions
    .map((version) => {
      const versionData = generationData
        .filter((x) => x.modelVersionId === version.id)
        .map((x) => ({
          createdAt: dayjs(x.createdAt).format('YYYY-MM-DD'),
          generations: x.generations,
        }));

      const generations = versionData.reduce((acc, curr) => acc + curr.generations, 0);

      return { ...version, data: versionData, generations };
    })
    .filter((v) => v.data.length > 0)
    // Pre-sort by most generations.
    .sort((a, b) => b.generations - a.generations);

  return versions;
};
