import { Prisma } from '@prisma/client';
import {
  Availability,
  CommercialUse,
  ModelStatus,
  ModelType,
  ModelVersionEngagementType,
} from '~/shared/utils/prisma/enums';
import { TRPCError } from '@trpc/server';
import dayjs from 'dayjs';
import { SessionUser } from 'next-auth';
import { env } from '~/env/server';
import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL, constants } from '~/server/common/constants';
import {
  EntityAccessPermission,
  NotificationCategory,
  SearchIndexUpdateQueueAction,
} from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { getDbWithoutLag, preventReplicationLag } from '~/server/db/db-helpers';
import { dataForModelsCache, modelVersionAccessCache } from '~/server/redis/caches';

import { logToAxiom } from '~/server/logging/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { TransactionType } from '~/server/schema/buzz.schema';
import { ModelFileMetadata, TrainingResultsV2 } from '~/server/schema/model-file.schema';
import {
  DeleteExplorationPromptInput,
  EarlyAccessModelVersionsOnTimeframeSchema,
  GetModelVersionByModelTypeProps,
  ModelVersionEarlyAccessConfig,
  ModelVersionMeta,
  ModelVersionsGeneratedImagesOnTimeframeSchema,
  ModelVersionUpsertInput,
  PublishVersionInput,
  QueryModelVersionSchema,
  RecommendedSettingsSchema,
  UpsertExplorationPromptInput,
} from '~/server/schema/model-version.schema';
import { ModelMeta, UnpublishModelSchema } from '~/server/schema/model.schema';
import {
  imagesMetricsSearchIndex,
  imagesSearchIndex,
  modelsSearchIndex,
} from '~/server/search-index';
import { throwOnBlockedLinkDomain } from '~/server/services/blocklist.service';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { hasEntityAccess } from '~/server/services/common.service';
import { checkDonationGoalComplete } from '~/server/services/donation-goal.service';
import { createNotification } from '~/server/services/notification.service';
import { bustOrchestratorModelCache } from '~/server/services/orchestrator/models';
import {
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getBaseModelSet } from '~/shared/constants/generation.constants';
import { maxDate } from '~/utils/date-helpers';
import { isDefined } from '~/utils/type-guards';
import { ingestModelById, updateModelLastVersionAt } from './model.service';
import { createCachedArray } from '~/server/utils/cache-helpers';
import { REDIS_KEYS } from '~/server/redis/client';

export const getModelVersionRunStrategies = async ({
  modelVersionId,
}: {
  modelVersionId: number;
}) =>
  dbRead.runStrategy.findMany({
    where: { modelVersionId },
    select: {
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

export const getUserEarlyAccessModelVersions = async ({ userId }: { userId: number }) => {
  return await dbRead.modelVersion.findMany({
    where: {
      earlyAccessEndsAt: { gt: new Date() },
      model: {
        userId,
        deletedAt: null,
      },
    },
    select: { id: true },
  });
};

export const upsertModelVersion = async ({
  id,
  monetization,
  settings,
  recommendedResources,
  templateId,
  earlyAccessConfig: updatedEarlyAccessConfig,
  ...data
}: Omit<ModelVersionUpsertInput, 'trainingDetails'> & {
  meta?: Prisma.ModelVersionCreateInput['meta'];
  trainingDetails?: Prisma.ModelVersionCreateInput['trainingDetails'];
}) => {
  if (data.description) await throwOnBlockedLinkDomain(data.description);
  // const model = await dbWrite.model.findUniqueOrThrow({ where: { id: data.modelId } });
  if (
    updatedEarlyAccessConfig?.timeframe &&
    !updatedEarlyAccessConfig?.chargeForDownload &&
    !updatedEarlyAccessConfig?.chargeForGeneration
  ) {
    throw throwBadRequestError(
      'You must charge for downloads or generations if you set an early access time frame.'
    );
  }

  if (updatedEarlyAccessConfig?.chargeForDownload && !updatedEarlyAccessConfig.downloadPrice) {
    throw throwBadRequestError('You must provide a download price when charging for downloads.');
  }

  if (updatedEarlyAccessConfig?.chargeForGeneration && !updatedEarlyAccessConfig.generationPrice) {
    throw throwBadRequestError(
      'You must provide a generation price when charging for generations.'
    );
  }

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
          availability: [ModelStatus.Published, ModelStatus.Scheduled].some(
            (s) => s === data?.status
          )
            ? Availability.Public
            : Availability.Private,
          earlyAccessConfig:
            updatedEarlyAccessConfig !== null ? updatedEarlyAccessConfig : Prisma.JsonNull,
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
    await bustMvCache(version.id);
    await dataForModelsCache.bust(version.modelId);

    return version;
  } else {
    const existingVersion = await dbRead.modelVersion.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        status: true,
        description: true,
        trainedWords: true,
        earlyAccessEndsAt: true,
        earlyAccessConfig: true,
        publishedAt: true,
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

    const earlyAccessConfig =
      existingVersion.earlyAccessConfig !== null
        ? (existingVersion.earlyAccessConfig as unknown as ModelVersionEarlyAccessConfig)
        : null;

    if (
      existingVersion.status === ModelStatus.Published &&
      !!updatedEarlyAccessConfig &&
      !earlyAccessConfig
    ) {
      throw throwBadRequestError(
        'You cannot add early access on a model after it has been published.'
      );
    }

    if (
      existingVersion.status === ModelStatus.Published &&
      updatedEarlyAccessConfig &&
      earlyAccessConfig
    ) {
      // Check all changes related now:

      if (
        updatedEarlyAccessConfig.chargeForDownload &&
        (updatedEarlyAccessConfig.downloadPrice as number) >
          (earlyAccessConfig.downloadPrice as number)
      ) {
        throw throwBadRequestError(
          'You cannot increase the download price on a model after it has been published.'
        );
      }

      if (updatedEarlyAccessConfig.timeframe > earlyAccessConfig?.timeframe) {
        throw throwBadRequestError(
          'You cannot increase the early access time frame for a published early access model version.'
        );
      }

      if (
        updatedEarlyAccessConfig.donationGoalEnabled !== earlyAccessConfig.donationGoalEnabled ||
        updatedEarlyAccessConfig.donationGoal !== earlyAccessConfig.donationGoal
      ) {
        throw throwBadRequestError(
          'You cannot update donation goals on a published early access model version.'
        );
      }
    }

    updatedEarlyAccessConfig = updatedEarlyAccessConfig
      ? // Ensures we keep relevant data such as buzzTransactionId even if the user changes something.
        { ...earlyAccessConfig, ...updatedEarlyAccessConfig }
      : updatedEarlyAccessConfig;

    const version = await dbWrite.modelVersion.update({
      where: { id },
      data: {
        ...data,
        availability: [ModelStatus.Published, ModelStatus.Scheduled].some((s) => s === data?.status)
          ? Availability.Public
          : Availability.Private,
        earlyAccessConfig:
          updatedEarlyAccessConfig !== null ? updatedEarlyAccessConfig : Prisma.JsonNull,
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
    await bustMvCache(version.id);
    await dataForModelsCache.bust(version.modelId);

    // Run it in the background to avoid blocking the request.
    ingestModelById({ id: version.modelId }).catch((error) =>
      logToAxiom({ type: 'error', name: 'model-ingestion', error, modelId: version.modelId })
    );

    return version;
  }
};

export const deleteVersionById = async ({ id }: GetByIdInput) => {
  const version = await dbWrite.$transaction(async (tx) => {
    const data = await tx.modelVersion.findFirstOrThrow({
      where: { id },
      select: {
        id: true,
        modelId: true,
        status: true,
        earlyAccessConfig: true,
        meta: true,
      },
    });

    const meta = data.meta as ModelVersionMeta;
    if (meta?.hadEarlyAccessPurchase) {
      throw throwBadRequestError(
        'Cannot delete a model version that has had early access purchases.'
      );
    }

    const deleted = await tx.modelVersion.delete({ where: { id } });
    await updateModelLastVersionAt({ id: deleted.modelId, tx });
    await preventReplicationLag('modelVersion', deleted.modelId);
    await bustMvCache(deleted.id);

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
  await bustMvCache(id);
};

export const publishModelVersionsWithEarlyAccess = async ({
  modelVersionIds,
  publishedAt,
  meta,
  tx,
  continueOnError = false,
}: {
  modelVersionIds: number[];
  publishedAt?: Date;
  meta?: ModelVersionMeta;
  tx?: Prisma.TransactionClient;
  continueOnError?: boolean;
}) => {
  if (modelVersionIds.length === 0) return [];
  const dbClient = tx ?? dbWrite;

  const versions = await dbClient.modelVersion.findMany({
    where: { id: { in: modelVersionIds } },
    select: {
      id: true,
      name: true,
      earlyAccessConfig: true,
      model: { select: { id: true, userId: true, name: true } },
    },
  });

  const updatedVersions = await Promise.all(
    versions.map(async (currentVersion) => {
      try {
        const earlyAccessConfig =
          currentVersion.earlyAccessConfig as ModelVersionEarlyAccessConfig | null;

        if (earlyAccessConfig && !earlyAccessConfig.donationGoalId) {
          earlyAccessConfig.originalPublishedAt = publishedAt; // Store the original published at date for future reference.

          if (earlyAccessConfig.donationGoalEnabled && earlyAccessConfig.donationGoal) {
            // Good time to also create the donation goal:
            const donationGoal = await dbClient.donationGoal.create({
              data: {
                goalAmount: earlyAccessConfig.donationGoal as number,
                title: `Early Access Donation Goal`,
                active: true,
                isEarlyAccess: true,
                modelVersionId: currentVersion.id,
                userId: currentVersion.model.userId,
              },
            });

            if (donationGoal) {
              earlyAccessConfig.donationGoalId = donationGoal.id;
            }
          }
        }

        const updatedVersion = await dbClient.modelVersion.update({
          where: { id: currentVersion.id },
          data: {
            status: ModelStatus.Published,
            publishedAt: publishedAt,
            earlyAccessConfig: earlyAccessConfig ?? undefined,
            meta,
            // Will be overwritten anyway by EA.
            availability: Availability.Public,
          },
          select: {
            id: true,
            modelId: true,
            baseModel: true,
            model: { select: { userId: true, id: true, type: true, nsfw: true } },
          },
        });

        await bustMvCache(updatedVersion.id);

        // TODO @Luis do we need to do the below here?
        // await modelsSearchIndex.queueUpdate([
        //   { id: version.model.id, action: SearchIndexUpdateQueueAction.Update },
        // ]);
        // await imagesSearchIndex.queueUpdate(
        //   images.map((image) => ({ id: image.id, action: SearchIndexUpdateQueueAction.Update }))
        // );
        // await imagesMetricsSearchIndex.queueUpdate(
        //   images.map((image) => ({ id: image.id, action: SearchIndexUpdateQueueAction.Update }))
        // );

        return updatedVersion;
      } catch (e: any) {
        console.log(e.message);
        if (e?.message?.includes('Insufficient funds to pay for early access.')) {
          // Create a notification for the user that the early access failed.
          createNotification({
            userId: currentVersion.model.userId,
            type: 'early-access-failed-to-publish',
            category: NotificationCategory.System,
            details: {
              error: e,
              modelVersionId: currentVersion.id,
              modelId: currentVersion.model.id,
              displayName: `${currentVersion.model.name}: ${currentVersion.name}`,
            },
            key: `early-access-failed-to-publish:${currentVersion.id}`,
          }).catch((error) => {
            // Print out any errors
            // TODO.logs: sent to logger service
            console.error(error);
          });
        }

        if (!continueOnError) throw e;
      }
    })
  );

  return updatedVersions;
};

export const publishModelVersionById = async ({
  id,
  publishedAt,
  meta,
  republishing,
}: PublishVersionInput & {
  meta?: ModelVersionMeta;
  republishing?: boolean;
}) => {
  let status: ModelStatus = ModelStatus.Published;
  if (publishedAt && publishedAt > new Date()) status = ModelStatus.Scheduled;
  else publishedAt = new Date();

  const currentVersion = await dbRead.modelVersion.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      name: true,
      earlyAccessConfig: true,
      model: { select: { userId: true, name: true } },
    },
  });

  const version = await dbWrite.$transaction(
    async (tx) => {
      let updatedVersion;
      if (status === ModelStatus.Published && currentVersion.earlyAccessConfig) {
        // We should charge for thisL
        const [updated] = await publishModelVersionsWithEarlyAccess({
          modelVersionIds: [id],
          publishedAt,
          meta,
          tx,
        });

        if (!updated) {
          throw throwBadRequestError('Failed to publish model version.');
        }

        updatedVersion = updated;
      }

      if (!updatedVersion) {
        updatedVersion = await dbWrite.modelVersion.update({
          where: { id },
          data: {
            status,
            publishedAt: !republishing ? publishedAt : undefined,
            meta,
            availability: Availability.Public,
          },
          select: {
            id: true,
            modelId: true,
            baseModel: true,
            model: { select: { userId: true, id: true, type: true, nsfw: true } },
          },
        });
      }

      await tx.$executeRaw`
        UPDATE "Post"
        SET
          "publishedAt" = CASE
            WHEN "metadata"->>'prevPublishedAt' IS NOT NULL
            THEN to_timestamp("metadata"->>'prevPublishedAt', 'YYYY-MM-DD"T"HH24:MI:SS.MS')
            ELSE ${publishedAt}
          END,
          "metadata" = "metadata" - 'unpublishedAt' - 'unpublishedBy' - 'prevPublishedAt'
        WHERE "userId" = ${updatedVersion.model.userId}
        AND "modelVersionId" = ${updatedVersion.id}
      `;

      return updatedVersion;
    },
    { timeout: 10000 }
  );

  if (!version) throw throwNotFoundError('Something went wrong. Please try again.');

  // Fetch all posts and images related to the model version to update in search index
  const posts = await dbRead.post.findMany({
    where: { modelVersionId: version.id, userId: version.model.userId },
    select: { id: true },
  });
  const images = await dbRead.image.findMany({
    where: { postId: { in: posts.map((x) => x.id) } },
    select: { id: true },
  });

  if (!republishing && !meta?.unpublishedBy)
    await updateModelLastVersionAt({ id: version.modelId });
  await bustMvCache(version.id);

  await preventReplicationLag('model', version.modelId);
  await preventReplicationLag('modelVersion', id);

  // Update search index for model and images
  await modelsSearchIndex.queueUpdate([
    { id: version.model.id, action: SearchIndexUpdateQueueAction.Update },
  ]);
  await imagesSearchIndex.queueUpdate(
    images.map((image) => ({ id: image.id, action: SearchIndexUpdateQueueAction.Update }))
  );
  await imagesMetricsSearchIndex.queueUpdate(
    images.map((image) => ({ id: image.id, action: SearchIndexUpdateQueueAction.Update }))
  );

  // Run it in the background to avoid blocking the request.
  ingestModelById({ id: version.modelId }).catch((error) =>
    logToAxiom({ type: 'error', name: 'model-ingestion', error, modelId: version.modelId })
  );

  return version;
};

export const unpublishModelVersionById = async ({
  id,
  reason,
  customMessage,
  meta,
  user,
}: UnpublishModelSchema & { meta?: ModelMeta; user: SessionUser }) => {
  const unpublishedAt = new Date().toISOString();
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
            unpublishedAt,
            unpublishedBy: user.id,
          },
        },
        select: { id: true, model: { select: { id: true, userId: true, nsfw: true } } },
      });

      await tx.$executeRaw`
        UPDATE "Post"
        SET
          "metadata" = "metadata" || jsonb_build_object(
            'unpublishedAt', ${unpublishedAt},
            'unpublishedBy', ${user.id},
            'prevPublishedAt', "publishedAt"
          ),
          "publishedAt" = NULL
        WHERE "publishedAt" IS NOT NULL
        AND "userId" = ${updatedVersion.model.userId}
        AND "modelVersionId" = ${updatedVersion.id}
      `;

      await preventReplicationLag('model', updatedVersion.model.id);
      await preventReplicationLag('modelVersion', updatedVersion.id);

      return updatedVersion;
    },
    { timeout: 10000 }
  );

  // Fetch all posts and images related to the model version to remove from search index
  const posts = await dbRead.post.findMany({
    where: { modelVersionId: version.id, userId: version.model.userId },
    select: { id: true },
  });
  const images = await dbRead.image.findMany({
    where: { postId: { in: posts.map((x) => x.id) } },
    select: { id: true },
  });

  await modelsSearchIndex.queueUpdate([
    { id: version.model.id, action: SearchIndexUpdateQueueAction.Update },
  ]);
  await imagesSearchIndex.queueUpdate(
    images.map((image) => ({ id: image.id, action: SearchIndexUpdateQueueAction.Delete }))
  );
  await imagesMetricsSearchIndex.queueUpdate(
    images.map((image) => ({ id: image.id, action: SearchIndexUpdateQueueAction.Delete }))
  );

  await updateModelLastVersionAt({ id: version.model.id });
  await bustMvCache(version.id);

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

export const getModelVersionsByModelType = async ({
  type,
  query,
  baseModel,
  take,
}: GetModelVersionByModelTypeProps) => {
  const sqlAnd = [Prisma.sql`mv.status = 'Published' AND m.type = ${type}::"ModelType"`];
  if (baseModel) {
    const baseModelSet = getBaseModelSet(baseModel);
    if (baseModelSet.baseModels.length)
      sqlAnd.push(Prisma.sql`mv."baseModel" IN (${Prisma.join(baseModelSet.baseModels, ',')})`);
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

type ModelVersionForGeneratedImages = {
  id: number;
  modelName: string;
  modelVersionName: string;
  userId: number;
};
type Row = { modelVersionId: number; createdAt: Date; generations: number };
export const modelVersionGeneratedImagesOnTimeframe = async ({
  userId,
  // Timeframe is on days
  timeframe = 31,
}: ModelVersionsGeneratedImagesOnTimeframeSchema & {
  userId: number;
}) => {
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

  const generationData = await clickhouse.$query<Row>`
    SELECT
      modelVersionId,
      date as createdAt,
      MAX(count) as generations
    FROM buzz_resource_compensation
    WHERE createdAt >= ${date}
    AND modelVersionId IN (${modelVersions.map((x) => x.id)})
    GROUP BY modelVersionId, date
    ORDER BY createdAt DESC, generations DESC;
  `;

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

const commercialUsePermissionContent = {
  [CommercialUse.None]: '',
  [CommercialUse.Image]: `
<b>Image Sales: Do not sell or license images generated by the Model. The following are a few examples of what is prohibited: selling or licensing a product such as a game, book, or other work that incorporates or is based on those generated images.</b>
`,
  [CommercialUse.Rent]: `
<b>Generation Services: Do not use the Model on any service that monetizes image generation. The following are a few examples of what is prohibited:
<ol type="a">
<li>Providing the Model on an as-a-service basis for a fee, whether as a subscription fee, per image generation fee, or otherwise; and</li>
<li>Providing the Model as-a-service on a platform that is ad-supported or presents advertising.</li>
</ol></b>
`,
  [CommercialUse.RentCivit]: `
<b>Civitai Generation Services: Do not run the Model on the Civitai platform for generation (available at [${env.NEXTAUTH_URL}/generate](/generate)).</b>
`,
  [CommercialUse.Sell]: `
<b>Sale of the Model: Do not sell or license the Model in exchange for a for a fee or something else of value.</b>
`,
};

export function addAdditionalLicensePermissions(
  license: string,
  options: {
    modelId: number;
    modelName: string;
    versionId: number;
    username: string | null;
    allowNoCredit: boolean;
    allowDerivatives: boolean;
    allowDifferentLicense: boolean;
    allowCommercialUse: CommercialUse[];
  }
) {
  license += `
<b>Attachment B

Additional Restrictions

This Attachment B supplements the license to which it is attached (“License”). In addition to any restrictions set forth in the License, the following additional terms apply.  The below restrictions apply to the Model and Derivatives of the Model, even though only the Model is referenced.  “Merge” means, with respect to the Model, combining the Model or a Derivative of the Model with one or more other models to produce a single model. A Derivative of the Model will be understood to include Merges.

You agree to the following with respect to the Model (each a “Permission”):
</b>
`;

  if (!options.allowNoCredit) {
    const modelUrl = `${env.NEXTAUTH_URL}/models/${options.modelId}?modelVersionId=${options.versionId}`;
    const creatorUrl = `${env.NEXTAUTH_URL}/user/${options.username}`;
    const licenseUrl = `${env.NEXTAUTH_URL}/models/license/${options.versionId}`;

    license += `
<b>Creator Credit: to use or distribute the Model you must credit the creator as follows:
- Model: ${options.modelName} [${modelUrl}](${modelUrl})
- Creator: ${options.username} [${creatorUrl}](${creatorUrl})
- License: [${licenseUrl}](${licenseUrl})
</b>
`;
  }

  if (!options.allowDerivatives) {
    license += `
<b>Do not Share or make available a Merge. The following are a few examples of what is prohibited:
<ol type="a">
<li>Running an image generation service that uses a Merge; and</li>
<li>Making a Merge available for deployment by another person on an as-a-service basis, download, or otherwise.</li>
</ol></b>
`;
  }

  if (options.allowDifferentLicense) {
    license += `
<b>Changing Permissions: modify or eliminate any of the applicable Permissions when sharing or making available a Derivative of the Model.</b>
`;
  }

  const additionalCommercialRestrictions = Object.entries(commercialUsePermissionContent)
    .map(([key, value]) => {
      if (options.allowCommercialUse.includes(key as CommercialUse)) return '';
      return value;
    })
    .join('');
  license += additionalCommercialRestrictions;

  return license;
}

export const earlyAccessPurchase = async ({
  userId,
  modelVersionId,
  type = 'download',
}: {
  userId: number;
  modelVersionId: number;
  type: 'generation' | 'download';
}) => {
  const permission =
    type === 'generation'
      ? EntityAccessPermission.EarlyAccessGeneration
      : EntityAccessPermission.EarlyAccessDownload;
  const buzzTransactionKey = `${type}-buzzTransactionId`;

  const modelVersion = await getVersionById({
    id: modelVersionId,
    select: {
      id: true,
      earlyAccessEndsAt: true,
      earlyAccessConfig: true,
      status: true,
      name: true,
      model: {
        select: {
          name: true,
          userId: true,
        },
      },
    },
  });

  if (!modelVersion) {
    throw throwNotFoundError('Model version not found.');
  }

  if (userId === modelVersion.model.userId) {
    throw throwBadRequestError('You cannot purchase early access for your own model.');
  }

  const earlyAccesConfig = modelVersion.earlyAccessConfig as ModelVersionEarlyAccessConfig | null;

  if (!earlyAccesConfig || !modelVersion.earlyAccessEndsAt) {
    throw throwBadRequestError('This model version does not have early access enabled.');
  }

  const earlyAccessDonationGoal = earlyAccesConfig.donationGoalId
    ? await dbRead.donationGoal.findFirst({
        where: { id: earlyAccesConfig.donationGoalId, isEarlyAccess: true, active: true },
      })
    : undefined;

  if (modelVersion.status !== ModelStatus.Published) {
    throw throwBadRequestError('You can only purchase early access for published models.');
  }

  if (modelVersion.earlyAccessEndsAt < new Date()) {
    throw throwBadRequestError('This model is public and does not require purchase.');
  }

  if (type === 'download' && !earlyAccesConfig.chargeForDownload) {
    throw throwBadRequestError('This model version does not support purchasing download.');
  }

  if (
    type === 'generation' &&
    (!earlyAccesConfig.chargeForGeneration || !earlyAccesConfig.generationPrice)
  ) {
    throw throwBadRequestError('This model version does not support purchasing generation only.');
  }

  // Confirm this user does not have early access:
  const [access] = await hasEntityAccess({
    entityIds: [modelVersionId],
    entityType: 'ModelVersion',
  });

  if (
    access?.hasAccess &&
    access?.meta?.[buzzTransactionKey] &&
    (access?.permissions & permission) !== 0
  ) {
    // This user has already purchased early access.
    throw throwBadRequestError('You have already purchased early access for this model.');
  }

  let buzzTransactionId: string | undefined;
  const amount =
    type === 'download'
      ? (earlyAccesConfig.downloadPrice as number)
      : (earlyAccesConfig.generationPrice as number);

  try {
    const buzzTransaction = await createBuzzTransaction({
      fromAccountId: userId,
      toAccountId: modelVersion.model.userId,
      amount,
      type: TransactionType.Purchase,
      description: `Gain early access on model: ${modelVersion.model.name} - ${modelVersion.name}`,
      details: { modelVersionId, type, earlyAccessPurchase: true },
    });

    buzzTransactionId = buzzTransaction.transactionId;
    const accessRecord = await dbWrite.entityAccess.findFirst({
      where: {
        accessorId: userId,
        accessorType: 'User',
        accessToId: modelVersionId,
        accessToType: 'ModelVersion',
      },
    });

    await dbWrite.$transaction(async (tx) => {
      if (accessRecord) {
        // Should only happen if the user purchased Generation but NOT download.
        // Update entity access:
        await tx.entityAccess.update({
          where: {
            accessToId_accessToType_accessorId_accessorType: {
              accessToId: modelVersionId,
              accessToType: 'ModelVersion',
              accessorId: userId,
              accessorType: 'User',
            },
          },
          data: {
            permissions: Math.max(
              EntityAccessPermission.EarlyAccessDownload +
                EntityAccessPermission.EarlyAccessGeneration,
              access.permissions ?? 0
            ),
            meta: { ...(access.meta ?? {}), [`${type}-buzzTransactionId`]: buzzTransactionId },
          },
        });
      } else {
        // Grant entity access:
        await tx.entityAccess.create({
          data: {
            accessToId: modelVersionId,
            accessToType: 'ModelVersion',
            accessorId: userId,
            accessorType: 'User',
            permissions:
              type === 'generation'
                ? EntityAccessPermission.EarlyAccessGeneration
                : EntityAccessPermission.EarlyAccessGeneration +
                  EntityAccessPermission.EarlyAccessDownload,
            meta: { [`${type}-buzzTransactionId`]: buzzTransactionId },
            addedById: userId, // Since it's a purchase
          },
        });
      }

      if (earlyAccessDonationGoal) {
        // Create a donation record:
        await tx.donation.create({
          data: {
            amount,
            donationGoalId: earlyAccessDonationGoal.id,
            userId,
            buzzTransactionId: buzzTransactionId as string,
          },
        });
      }

      // Set model version early access purchase as true:
      await tx.$queryRaw`
        UPDATE "ModelVersion"
        SET meta = jsonb_set(
          COALESCE(meta, '{}'::jsonb),
          '{hadEarlyAccessPurchase}',
          to_jsonb(${true})
        )
        WHERE "id" = ${modelVersionId}; -- Your conditions here
      `;
    });

    if (earlyAccessDonationGoal) {
      await checkDonationGoalComplete({ donationGoalId: earlyAccessDonationGoal.id });
    }

    // Ensures user gets access to the resource after purchasing.
    await bustMvCache(modelVersionId, userId);

    return true;
  } catch (error) {
    if (buzzTransactionId) {
      // Refund:
      await createBuzzTransaction({
        fromAccountId: modelVersion.model.userId,
        toAccountId: userId,
        amount,
        type: TransactionType.Refund,
        description: `Refund early access on model: ${modelVersion.model.name} - ${modelVersion.name}`,
      });
    }
    throw throwDbError(error);
  }
};

export const modelVersionDonationGoals = async ({
  id,
  userId,
  isModerator,
}: {
  id: number;
  userId?: number;
  isModerator?: boolean;
}) => {
  const version = await dbRead.modelVersion.findFirstOrThrow({
    where: { id },
    select: {
      id: true,
      modelId: true,
      earlyAccessEndsAt: true,
      model: {
        select: {
          userId: true,
        },
      },
    },
  });

  const canSeeAllGoals = userId === version.model.userId || isModerator;

  const donationGoals = await dbRead.donationGoal.findMany({
    where: {
      modelVersionId: id,
      active: canSeeAllGoals ? undefined : true,
      isEarlyAccess: version.earlyAccessEndsAt || canSeeAllGoals ? undefined : false, // Avoids returning earlyAccessGoals for public models.
    },
    select: {
      id: true,
      goalAmount: true,
      title: true,
      active: true,
      isEarlyAccess: true,
      userId: true,
      createdAt: true,
      description: true,
    },
  });

  if (donationGoals.length === 0) {
    return [];
  }

  const donationTotals = await dbRead.$queryRaw<{ donationGoalId: number; total: number }[]>`
    SELECT
      "donationGoalId",
      SUM("amount")::int as total
    FROM "Donation"
    WHERE "donationGoalId" IN (${Prisma.join(donationGoals.map((x) => x.id))})
    GROUP BY "donationGoalId"
  `;

  return donationGoals.map((goal) => {
    const total = donationTotals.find((x) => x.donationGoalId === goal.id)?.total ?? 0;
    return { ...goal, total };
  });
};

export async function queryModelVersions<TSelect extends Prisma.ModelVersionSelect & { id: true }>({
  user,
  query,
  select,
}: {
  user?: SessionUser;
  query: QueryModelVersionSchema;
  select: TSelect;
}) {
  const { cursor, limit, trainingStatus } = query;
  const AND: Prisma.Enumerable<Prisma.ModelVersionWhereInput> = [];
  if (trainingStatus) AND.push({ trainingStatus });

  const where: Prisma.ModelVersionWhereInput = { AND };

  const items = await dbRead.modelVersion.findMany({
    where,
    cursor: cursor ? { id: cursor } : undefined,
    take: limit + 1,
    select: select,
    orderBy: { id: 'desc' },
  });

  let nextCursor: number | undefined;
  if (items.length > limit) {
    const nextItem = (items as { id: number }[]).pop();
    nextCursor = nextItem?.id;
  }

  return { items, nextCursor };
}

export const bustMvCache = async (ids: number | number[], userId?: number) => {
  await resourceDataCache.bust(ids);
  await bustOrchestratorModelCache(ids, userId);
  await modelVersionAccessCache.bust(ids);
};

export const getWorkflowIdFromModelVersion = async ({ id }: GetByIdInput) => {
  const modelVersion = await dbRead.modelVersion.findFirst({
    where: {
      id,
    },
    select: {
      id: true,
      files: {
        select: {
          id: true,
          metadata: true,
        },
      },
    },
  });

  if (!modelVersion) return null;

  const modelFile = modelVersion.files?.[0];
  if (!modelFile) return null;

  const metadata = modelFile.metadata as ModelFileMetadata;
  if (!metadata) return null;

  const trainingResults = (metadata.trainingResults ?? {}) as TrainingResultsV2;

  return trainingResults.workflowId ?? null;
};

export const resourceDataCache = createCachedArray({
  key: REDIS_KEYS.GENERATION.RESOURCE_DATA,
  lookupFn: async (ids) => {
    if (!ids.length) return {};
    const dbResults = await dbRead.$queryRaw<GenerationResourceDataModel[]>`
      SELECT
        mv."id",
        mv."name",
        mv."trainedWords",
        mv."baseModel",
        mv."settings",
        mv."availability",
        mv."clipSkip",
        mv."vaeId",
        mv."earlyAccessEndsAt",
        (CASE WHEN mv."availability" = 'EarlyAccess' THEN mv."earlyAccessConfig" END) as "earlyAccessConfig",
        gc."covered",
        (
          SELECT to_json(obj)
          FROM (
            SELECT
              m."id",
              m."name",
              m."type",
              m."nsfw",
              m."poi",
              m."minor",
              m."userId"
            FROM "Model" m
            WHERE m.id = mv."modelId"
          ) as obj
        ) as model
      FROM "ModelVersion" mv
      LEFT JOIN "GenerationCoverage" gc ON gc."modelVersionId" = mv.id
      WHERE mv.id IN (${Prisma.join(ids)})
    `;

    const results = dbResults.reduce<Record<number, GenerationResourceDataModel>>(
      (acc, result) => ({ ...acc, [result.id]: result }),
      {}
    );
    return results;
  },
  idKey: 'id',
  dontCacheFn: (data) => {
    const cacheable = ['Public', 'Unsearchable'].includes(data.availability);
    return !cacheable || !data.covered;
  },
  ttl: CacheTTL.hour,
});

export type GenerationResourceDataModel = {
  id: number;
  name: string;
  trainedWords: string[];
  clipSkip: number | null;
  vaeId: number | null;
  baseModel: string;
  settings: RecommendedSettingsSchema | null;
  availability: Availability;
  earlyAccessEndsAt: Date | null;
  earlyAccessConfig?: ModelVersionEarlyAccessConfig | null;
  covered: boolean | null;
  model: {
    id: number;
    name: string;
    type: ModelType;
    nsfw: boolean;
    poi: boolean;
    minor: boolean;
    userId: number;
  };
};
