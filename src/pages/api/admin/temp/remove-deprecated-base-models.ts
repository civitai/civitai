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

const log = createLogger('remove-deprecated-base-models', 'red');
const NOTIFICATION_BATCH_SIZE = 100;

const querySchema = z.object({
  dryRun: booleanString().default(true),
});

export default WebhookEndpoint(async (req, res) => {
  const result = querySchema.safeParse(req.query);
  if (!result.success) {
    return res.status(400).json({ ok: false, error: z.treeifyError(result.error) });
  }

  const { dryRun } = result.data;
  const startTime = Date.now();
  log(`Starting bulk base model removal process${dryRun ? ' (DRY RUN)' : ''}`);

  try {
    const result = await dbWrite.$transaction(
      async (tx) => {
        // Step 1: Find all affected ModelVersions
        const step1Start = Date.now();
        log('Finding affected ModelVersions...');
        const affectedVersions = await tx.modelVersion.findMany({
          where: {
            baseModel: { in: [...DEPRECATED_BASE_MODELS] },
            status: { not: ModelStatus.Deleted },
          },
          take: 10,
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
          return {
            usersNotified: 0,
            usersToNotify: 0,
            deletedModelIds: [],
            affectedUserIds: [],
            affectedVersions: [],
            message: 'No affected ModelVersions found',
          };
        }

        // Step 2: Track affected Models and users
        const affectedModelIds = [...new Set(affectedVersions.map((v) => v.modelId))];
        const affectedUserIds = [...new Set(affectedVersions.map((v) => v.model.userId))];

        // Step 3: Soft delete all affected ModelVersions
        const step3Start = Date.now();
        if (!dryRun) {
          log('Soft deleting ModelVersions...');
          await tx.modelVersion.updateMany({
            where: {
              id: { in: affectedVersions.map((v) => v.id) },
            },
            data: {
              status: ModelStatus.Deleted,
            },
          });
          log(`Step 3: Deleted ${affectedVersions.length} versions (${Date.now() - step3Start}ms)`);

          // Step 3b: Clean up each deleted version
          log('Cleaning up deleted ModelVersions...');
          for (const version of affectedVersions) {
            await bustMvCache(version.id, version.modelId);
            await deleteBidsForModelVersion({ modelVersionId: version.id, tx });
          }
          log(`Step 3b: Cleaned up ${affectedVersions.length} versions`);

          // Step 3c: Update lastVersionAt for affected models
          log('Updating model lastVersionAt timestamps...');
          for (const modelId of affectedModelIds) {
            await updateModelLastVersionAt({ id: modelId, tx });
          }
          log(`Step 3c: Updated ${affectedModelIds.length} models`);
        } else {
          log('DRY RUN: Would soft delete ModelVersions (skipping actual update)');
        }

        // Step 4: Find Models with no active versions (optimized single query)
        const step4Start = Date.now();
        log(`Checking ${affectedModelIds.length} affected Models...`);

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

        const modelsWithActiveVersionsSet = new Set(modelsWithActiveVersions.map((m) => m.modelId));
        const modelsToDelete = affectedModelIds.filter(
          (id) => !modelsWithActiveVersionsSet.has(id)
        );
        log(
          `Step 4: Found ${modelsToDelete.length} models to delete (${Date.now() - step4Start}ms)`
        );

        // Step 5: Soft delete Models with no active versions
        const step5Start = Date.now();
        if (modelsToDelete.length > 0 && !dryRun) {
          await tx.model.updateMany({
            where: {
              id: { in: modelsToDelete },
            },
            data: {
              deletedAt: new Date(),
              status: ModelStatus.Deleted,
            },
          });
          log(`Step 5: Deleted ${modelsToDelete.length} models (${Date.now() - step5Start}ms)`);

          // Step 5b: Clean up bids for deleted models
          log('Cleaning up bids for deleted models...');
          for (const modelId of modelsToDelete) {
            await deleteBidsForModel({ modelId, tx });
          }
          log(`Step 5b: Cleaned up bids for ${modelsToDelete.length} models`);
        } else if (modelsToDelete.length > 0) {
          log('DRY RUN: Would soft delete Models (skipping actual update)');
        }

        return {
          deletedModelIds: modelsToDelete,
          affectedUserIds,
          affectedVersions: affectedVersions.map((v) => ({
            id: v.id,
            name: v.name,
            baseModel: v.baseModel,
            modelId: v.modelId,
            modelName: v.model.name,
          })),
        };
      },
      { timeout: 30000, maxWait: 10000 }
    );

    // Step 6: Send notifications to affected users (outside transaction, batched)
    const step6Start = Date.now();
    if (!dryRun) {
      log(`Sending notifications to ${result.affectedUserIds.length} users in batches...`);

      const userBatches = chunk(result.affectedUserIds, NOTIFICATION_BATCH_SIZE);
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
        `Step 6: Notifications completed - ${successCount} sent, ${failCount} failed (${
          Date.now() - step6Start
        }ms)`
      );
    } else {
      log(`DRY RUN: Would send notifications to ${result.affectedUserIds.length} users (skipping)`);
    }

    if (!dryRun) {
      // Trigger meilisearch queue update
      await modelsSearchIndex.queueUpdate(
        result.affectedVersions.map((v) => ({
          id: v.modelId,
          action: SearchIndexUpdateQueueAction.Update,
        }))
      );
      await modelsSearchIndex.queueUpdate(
        result.deletedModelIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Delete }))
      );
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Process completed successfully in ${duration}s`);

    res.status(200).json({
      ok: true,
      dryRun,
      duration: `${duration}s`,
      result: {
        deletedVersions: result.affectedVersions.length,
        deletedModelIds: result.deletedModelIds.length,
        usersNotified: dryRun ? 0 : result.affectedUserIds.length,
        usersToNotify: result.affectedUserIds.length,
        deprecatedBaseModels: DEPRECATED_BASE_MODELS,
        affectedVersionsSample: result.affectedVersions.slice(0, 10),
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
