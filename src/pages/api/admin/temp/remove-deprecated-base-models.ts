import { ModelStatus } from '@prisma/client';
import { chunk } from 'lodash-es';
import * as z from 'zod';
import { createNotification } from '~/server/services/notification.service';
import { dbWrite } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';
import { NotificationCategory, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { DEPRECATED_BASE_MODELS } from '~/shared/constants/base-model.constants';
import { modelsSearchIndex } from '~/server/search-index';
import { updateModelLastVersionAt } from '~/server/services/model.service';
import { bustMvCache } from '~/server/services/model-version.service';
import { deleteBidsForModel, deleteBidsForModelVersion } from '~/server/services/auction.service';
import { Limiter } from '~/server/utils/concurrency-helpers';

const log = createLogger('remove-deprecated-base-models', 'red');

const querySchema = z.object({
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(1000).default(100),
});

export default WebhookEndpoint(async (req, res) => {
  const result = querySchema.safeParse(req.query);
  if (!result.success) {
    return res.status(400).json({ ok: false, error: z.treeifyError(result.error) });
  }

  const { dryRun, batchSize } = result.data;
  const startTime = Date.now();
  log(
    `Starting bulk base model removal process${
      dryRun ? ' (DRY RUN)' : ''
    } with batch size ${batchSize}`
  );

  // Step 1: Find all affected ModelVersions
  const step1Start = Date.now();
  log('Finding affected ModelVersions...');
  const affectedVersions = await dbWrite.modelVersion.findMany({
    where: {
      baseModel: { in: [...DEPRECATED_BASE_MODELS] },
      status: { not: ModelStatus.Deleted },
    },
    select: {
      id: true,
      name: true,
      baseModel: true,
      modelId: true,
      model: {
        select: {
          name: true,
          userId: true,
        },
      },
    },
  });
  log(`Step 1: Found ${affectedVersions.length} versions (${Date.now() - step1Start}ms)`);

  if (affectedVersions.length === 0) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Process completed successfully in ${duration}s`);

    return res.status(200).json({
      ok: true,
      dryRun,
      duration: `${duration}s`,
      result: {
        usersNotified: 0,
        usersToNotify: 0,
        deletedModelIds: [],
        affectedUserIds: [],
        affectedVersions: [],
        message: 'No affected ModelVersions found',
      },
    });
  }

  try {
    const data = await Limiter({ limit: 1, batchSize }).process(affectedVersions, async (batch) => {
      const result = await dbWrite.$transaction(
        async (tx) => {
          // Step 2: Track affected Models and users
          const affectedModelIds = [...new Set(batch.map((v) => v.modelId))];
          const affectedUserIds = [...new Set(batch.map((v) => v.model.userId))];

          // Step 3: Soft delete all affected ModelVersions
          const step3Start = Date.now();
          if (!dryRun) {
            log('Step 3: Soft deleting ModelVersions...');
            await tx.modelVersion.updateMany({
              where: {
                id: { in: batch.map((v) => v.id) },
              },
              data: {
                status: ModelStatus.Deleted,
              },
            });
            log(`Step 3: Soft deleted ${batch.length} versions (${Date.now() - step3Start}ms)`);

            // Step 4: Update lastVersionAt for affected models
            const step4Start = Date.now();
            log('Step 4: Updating model lastVersionAt timestamps...');
            for (const modelId of affectedModelIds) {
              await updateModelLastVersionAt({ id: modelId, tx });
            }
            log(`Step 4: Updated ${affectedModelIds.length} models (${Date.now() - step4Start}ms)`);
          } else {
            log('DRY RUN: Would soft delete ModelVersions (skipping actual update)');
          }

          // Step 5: Find Models with no active versions (optimized single query)
          const step5Start = Date.now();
          log(`Step 5: Checking ${affectedModelIds.length} affected Models...`);

          const modelsWithActiveVersions = await tx.modelVersion.groupBy({
            by: ['modelId'],
            where: {
              modelId: { in: affectedModelIds },
              status: { not: ModelStatus.Deleted },
            },
            _count: {
              modelId: true,
            },
          });

          const modelsWithActiveVersionsSet = new Set(
            modelsWithActiveVersions.map((m) => m.modelId)
          );
          const modelsToDelete = affectedModelIds.filter(
            (id) => !modelsWithActiveVersionsSet.has(id)
          );
          log(
            `Step 5: Found ${modelsToDelete.length} models to delete (${Date.now() - step5Start}ms)`
          );

          // Step 6: Soft delete Models with no active versions
          const step6Start = Date.now();
          if (modelsToDelete.length > 0 && !dryRun) {
            log('Step 6: Soft deleting Models with no active versions...');
            await tx.model.updateMany({
              where: {
                id: { in: modelsToDelete },
              },
              data: {
                deletedAt: new Date(),
                status: ModelStatus.Deleted,
              },
            });
            log(
              `Step 6: Soft deleted ${modelsToDelete.length} models (${Date.now() - step6Start}ms)`
            );
          } else if (modelsToDelete.length > 0) {
            log('DRY RUN: Would soft delete Models (skipping actual update)');
          }

          return {
            deletedModelIds: modelsToDelete,
            affectedUserIds,
            affectedVersions: batch.map((v) => ({
              id: v.id,
              name: v.name,
              baseModel: v.baseModel,
              modelId: v.modelId,
              modelName: v.model.name,
            })),
          };
        },
        { timeout: 60000, maxWait: 10000 }
      );

      return result;
    });

    // Reduce all batch results into a single object
    const aggregatedData = data.reduce(
      (acc, batch) => {
        acc.deletedModelIds.push(...batch.deletedModelIds);
        acc.affectedUserIds.push(...batch.affectedUserIds);
        acc.affectedVersions.push(...batch.affectedVersions);
        return acc;
      },
      {
        deletedModelIds: [] as number[],
        affectedUserIds: [] as number[],
        affectedVersions: [] as Array<{
          id: number;
          name: string;
          baseModel: string;
          modelId: number;
          modelName: string;
        }>,
      }
    );

    // Remove duplicates from user IDs
    const uniqueUserIds = [...new Set(aggregatedData.affectedUserIds)];
    aggregatedData.affectedUserIds = uniqueUserIds;

    // === POST-TRANSACTION CLEANUP (Steps 7-10) ===

    // Step 7: Clean up cache for deleted versions
    if (!dryRun && aggregatedData.affectedVersions.length > 0) {
      const step7Start = Date.now();
      log('Step 7: Cleaning up ModelVersion cache...');
      const versionIds = aggregatedData.affectedVersions.map((v) => v.id);
      const modelIds = [...new Set(aggregatedData.affectedVersions.map((v) => v.modelId))];
      await bustMvCache(versionIds, modelIds);
      log(
        `Step 7: Cleaned up ${aggregatedData.affectedVersions.length} version caches (${
          Date.now() - step7Start
        }ms)`
      );
    }

    // Step 8: Clean up bids for deleted versions
    if (!dryRun && aggregatedData.affectedVersions.length > 0) {
      const step8Start = Date.now();
      log('Step 8: Cleaning up bids for deleted ModelVersions...');

      await Limiter({ limit: 3, batchSize: 50 }).process(
        aggregatedData.affectedVersions,
        async (batch) => {
          await Promise.all(
            batch.map((version) => deleteBidsForModelVersion({ modelVersionId: version.id }))
          );
        }
      );

      log(
        `Step 8: Cleaned up bids for ${aggregatedData.affectedVersions.length} versions (${
          Date.now() - step8Start
        }ms)`
      );
    }

    // Step 9: Clean up bids for deleted models
    if (!dryRun && aggregatedData.deletedModelIds.length > 0) {
      const step9Start = Date.now();
      log('Step 9: Cleaning up bids for deleted Models...');

      await Limiter({ limit: 3, batchSize: 50 }).process(
        aggregatedData.deletedModelIds,
        async (batch) => {
          await Promise.all(batch.map((modelId) => deleteBidsForModel({ modelId })));
        }
      );

      log(
        `Step 9: Cleaned up bids for ${aggregatedData.deletedModelIds.length} models (${
          Date.now() - step9Start
        }ms)`
      );
    }

    // Step 10: Send notifications to affected users (batched)
    const step10Start = Date.now();
    if (!dryRun) {
      log(
        `Step 10: Sending notifications to ${aggregatedData.affectedUserIds.length} users in batches...`
      );

      const userBatches = chunk(aggregatedData.affectedUserIds, batchSize);
      let successCount = 0;
      let failCount = 0;

      for (const [batchIndex, batch] of userBatches.entries()) {
        log(
          `Processing notification batch ${batchIndex + 1}/${userBatches.length} (${
            batch.length
          } users)`
        );

        const batchResults = await Promise.allSettled(
          batch.map((userId) =>
            createNotification({
              key: `base-model-removal:${userId}`,
              type: 'system-message',
              category: NotificationCategory.System,
              userId,
              details: {
                message:
                  'Your models using deprecated base models (SD 3, SD 3.5, SDXL Turbo, SVD) have been removed from the site due to the termination of our Enterprise Agreement with Stability AI. As a result, all Stability AI Core Models are now not permitted on Civitai.',
                url: '/changelog?id=100',
              },
            })
          )
        );

        successCount += batchResults.filter((r) => r.status === 'fulfilled').length;
        failCount += batchResults.filter((r) => r.status === 'rejected').length;
      }

      log(
        `Step 10: Notifications completed - ${successCount} sent, ${failCount} failed (${
          Date.now() - step10Start
        }ms)`
      );
    } else {
      log(
        `DRY RUN: Would send notifications to ${aggregatedData.affectedUserIds.length} users (skipping)`
      );
    }

    if (!dryRun) {
      if (aggregatedData.deletedModelIds.length > 0) {
        await modelsSearchIndex.queueUpdate(
          aggregatedData.deletedModelIds.map((id) => ({
            id,
            action: SearchIndexUpdateQueueAction.Delete,
          }))
        );
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Process completed successfully in ${duration}s`);

    res.status(200).json({
      ok: true,
      dryRun,
      duration: `${duration}s`,
      result: {
        deletedVersions: aggregatedData.affectedVersions.length,
        deletedModelIds: aggregatedData.deletedModelIds.length,
        usersNotified: dryRun ? 0 : aggregatedData.affectedUserIds.length,
        usersToNotify: aggregatedData.affectedUserIds.length,
        deprecatedBaseModels: DEPRECATED_BASE_MODELS,
        affectedVersionsSample: aggregatedData.affectedVersions.slice(0, 10),
      },
    });
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Process failed after ${duration}s:`, error);

    res.status(500).json({
      ok: false,
      error: (error as Error).message,
      stack: (error as Error).stack,
    });
  }
});
