import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import { dataForModelsCache } from '~/server/redis/caches';
import {
  bustMvCache,
  publishModelVersionsWithEarlyAccess,
} from '~/server/services/model-version.service';
import { isDefined } from '~/utils/type-guards';
import { createJob, getJobDate } from './job';

type ScheduledEntity = {
  id: number;
  userId: number;
  extras?: { modelId: number; hasEarlyAccess?: boolean; earlyAccessEndsAt?: Date } & MixedObject;
};

export const processScheduledPublishing = createJob(
  'process-scheduled-publishing',
  '*/1 * * * *',
  async () => {
    const [, setLastRun] = await getJobDate('process-scheduled-publishing');
    const now = new Date();

    // Get things to publish
    const scheduledModels = await dbWrite.$queryRaw<ScheduledEntity[]>`
      SELECT
        id,
        "userId"
      FROM "Model"
      WHERE status = 'Scheduled' AND "publishedAt" <= ${now};
    `;
    const scheduledModelVersions = await dbWrite.$queryRaw<ScheduledEntity[]>`
      SELECT
        mv.id,
        m."userId",
        JSON_BUILD_OBJECT(
          'modelId', m.id,
          'hasEarlyAccess', mv."earlyAccessConfig" IS NOT NULL AND (mv."earlyAccessConfig"->>'timeframe')::int > 0,
          'earlyAccessEndsAt', mv."earlyAccessEndsAt"
        ) as "extras"
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE mv.status = 'Scheduled'
        AND mv."publishedAt" <= ${now}
        AND EXISTS (
          SELECT 1
          FROM "ModelFile" mf
          WHERE mf."modelVersionId" = mv.id
        )
    `;
    const scheduledPosts = await dbWrite.$queryRaw<ScheduledEntity[]>`
      SELECT
        p.id,
        p."userId"
      FROM "Post" p
      JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE
        (p."publishedAt" IS NULL)
      AND mv.status = 'Scheduled' AND mv."publishedAt" <=  ${now};
    `;

    await dbWrite.$transaction(
      async (tx) => {
        await tx.$executeRaw`
      -- Update last version of scheduled models
      UPDATE "Model" SET "lastVersionAt" = ${now}
      WHERE id IN (
        SELECT
          mv."modelId"
        FROM "ModelVersion" mv
        WHERE mv.status = 'Scheduled' AND mv."publishedAt" <= ${now}
      );`;

        if (scheduledModels.length) {
          const scheduledModelIds = scheduledModels.map(({ id }) => id);
          await tx.$executeRaw`
          -- Make scheduled models published
          UPDATE "Model" SET status = 'Published'
          WHERE id IN (${Prisma.join(scheduledModelIds)})
            AND status = 'Scheduled'
            AND "publishedAt" <= ${now};
        `;
        }

        if (scheduledPosts.length) {
          const scheduledPostIds = scheduledPosts.map(({ id }) => id);
          const returnedIds = await tx.$queryRaw<{ id: number }[]>`
          -- Update scheduled versions posts
          UPDATE "Post" p SET "publishedAt" = mv."publishedAt"
          FROM "ModelVersion" mv
          JOIN "Model" m ON m.id = mv."modelId"
          WHERE p.id IN (${Prisma.join(scheduledPostIds)})
            AND (p."publishedAt" IS NULL)
            AND mv.id = p."modelVersionId" AND m."userId" = p."userId"
            AND mv.status = 'Scheduled' AND mv."publishedAt" <= ${now}
          RETURNING p.id;
        `;

          // commenting this out, because it should be covered by the db_trigger `update_image_sort_at`
          // if (returnedIds.length) {
          //   await tx.$executeRaw`
          //     UPDATE "Image"
          //     SET "updatedAt" = NOW()
          //     WHERE "postId" IN (${Prisma.join(returnedIds.map((r) => r.id))})
          //   `;
          // }
        }

        if (scheduledModelVersions.length) {
          const earlyAccess = scheduledModelVersions
            .filter((item) => !!item.extras?.hasEarlyAccess)
            .map(({ id }) => id);

          await tx.$executeRaw`
            -- Update scheduled versions published
            UPDATE "ModelVersion" SET status = 'Published', availability = 'Public'
            WHERE id IN (${Prisma.join(scheduledModelVersions.map(({ id }) => id))})
              AND status = 'Scheduled' AND "publishedAt" <= ${now};
          `;

          if (earlyAccess.length) {
            // The only downside to this failing is that the model version will be published with no early access.
            // Initially, I think this will be OK.
            await publishModelVersionsWithEarlyAccess({
              modelVersionIds: earlyAccess,
              continueOnError: true,
              tx,
            });

            // Attempt to update the model early access deadline:
            await tx.$executeRaw`
              UPDATE "Model" mo
              SET "earlyAccessDeadline" = GREATEST(mea."earlyAccessDeadline", mo."earlyAccessDeadline")
              FROM (
                SELECT m.id, mv."earlyAccessEndsAt" AS "earlyAccessDeadline"
                FROM "ModelVersion" mv
                JOIN "Model" m on m.id = mv."modelId"
                WHERE mv.id IN (${Prisma.join(earlyAccess)})
              ) as mea
              WHERE mo."id" = mea."id"
            `;
          }
        }
      },
      {
        timeout: 10000,
      }
    );

    // Process event engagements
    for (const model of scheduledModels) {
      await eventEngine.processEngagement({
        userId: model.userId,
        type: 'published',
        entityType: 'model',
        entityId: model.id,
      });
    }
    for (const modelVersion of scheduledModelVersions) {
      await eventEngine.processEngagement({
        userId: modelVersion.userId,
        type: 'published',
        entityType: 'modelVersion',
        entityId: modelVersion.id,
      });
      await bustMvCache(modelVersion.id);
    }
    for (const post of scheduledPosts) {
      await eventEngine.processEngagement({
        userId: post.userId,
        type: 'published',
        entityType: 'post',
        entityId: post.id,
      });
    }

    const processedModelIds = [
      ...new Set([
        ...scheduledModels.map((entity) => entity.id),
        ...scheduledModelVersions.map((entity) => entity.extras?.modelId),
      ]),
    ].filter(isDefined);
    if (processedModelIds.length) await dataForModelsCache.bust(processedModelIds);

    await setLastRun();
  }
);
