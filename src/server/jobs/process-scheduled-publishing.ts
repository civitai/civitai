import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import { NotificationCategory } from '~/server/common/enums';
import { dataForModelsCache } from '~/server/redis/caches';
import {
  bustMvCache,
  publishModelVersionsWithEarlyAccess,
} from '~/server/services/model-version.service';
import { createNotification } from '~/server/services/notification.service';
import {
  updateComicChapterNsfwLevels,
  updateComicProjectNsfwLevels,
} from '~/server/services/nsfwLevels.service';
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
      WHERE status = 'Scheduled' 
        AND "publishedAt" <= ${now}
        AND (meta IS NULL OR (meta->>'cannotPublish')::boolean IS NOT TRUE);
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
        AND (m.meta IS NULL OR (m.meta->>'cannotPublish')::boolean IS NOT TRUE)
        AND EXISTS (
          SELECT 1
          FROM "ModelFile" mf
          WHERE mf."modelVersionId" = mv.id
        );
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
      AND mv.status = 'Scheduled' AND mv."publishedAt" <=  ${now}
      AND (m.meta IS NULL OR (m.meta->>'cannotPublish')::boolean IS NOT TRUE);
    `;

    // Get scheduled comic chapters
    const scheduledComicChapters = await dbWrite.$queryRaw<
      { projectId: number; position: number; userId: number; projectName: string; chapterName: string; username: string | null }[]
    >`
      SELECT
        cc."projectId",
        cc."position",
        cp."userId",
        cp."name" AS "projectName",
        cc."name" AS "chapterName",
        u."username"
      FROM "ComicChapter" cc
      JOIN "ComicProject" cp ON cp.id = cc."projectId"
      JOIN "User" u ON u.id = cp."userId"
      WHERE cc.status = 'Scheduled'
        AND cc."publishedAt" <= ${now}
    `;

    // Publish scheduled comic chapters
    if (scheduledComicChapters.length) {
      await dbWrite.$executeRaw`
        UPDATE "ComicChapter"
        SET status = 'Published'
        WHERE status = 'Scheduled'
          AND "publishedAt" <= ${now}
      `;

      // Update project publishedAt for first-time publishing projects
      const projectIds = [...new Set(scheduledComicChapters.map((ch) => ch.projectId))];
      for (const projectId of projectIds) {
        await dbWrite.comicProject.updateMany({
          where: { id: projectId, publishedAt: null },
          data: { publishedAt: now },
        });

        // Update NSFW levels
        updateComicChapterNsfwLevels([projectId]).catch((e) =>
          console.error(`Failed to update chapter NSFW for project ${projectId}:`, e)
        );
        updateComicProjectNsfwLevels([projectId]).catch((e) =>
          console.error(`Failed to update project NSFW for project ${projectId}:`, e)
        );
      }

      // Batch-fetch all followers for affected projects in a single query
      const allFollowers = await dbWrite.$queryRaw<{ projectId: number; userId: number }[]>`
        SELECT "projectId", "userId" FROM "ComicEngagement"
        WHERE "projectId" IN (${Prisma.join(projectIds)}) AND "type" = 'Notify'
      `;
      const followersByProject = new Map<number, number[]>();
      for (const f of allFollowers) {
        const list = followersByProject.get(f.projectId) ?? [];
        list.push(f.userId);
        followersByProject.set(f.projectId, list);
      }

      // Send follower notifications
      for (const ch of scheduledComicChapters) {
        const followerIds = followersByProject.get(ch.projectId) ?? [];
        if (followerIds.length > 0) {
          await createNotification({
            type: 'new-comic-chapter',
            key: `new-comic-chapter:${ch.projectId}:${ch.position}`,
            category: NotificationCategory.Update,
            userIds: followerIds,
            details: {
              comicProjectId: ch.projectId,
              comicProjectName: ch.projectName,
              chapterName: ch.chapterName,
              authorUsername: ch.username ?? 'Unknown',
            },
          });
        }
      }
    }

    await dbWrite.$transaction(
      async (tx) => {
        const modelsToUpdate = [
          ...new Set(scheduledModelVersions.map(({ extras }) => extras?.modelId).filter(isDefined)),
        ];

        if (modelsToUpdate.length) {
          await tx.$executeRaw`
            -- Update last version of models with versions transitioned to published
            UPDATE "Model"
            SET "lastVersionAt" = ${now}
            WHERE id IN (${Prisma.join(modelsToUpdate)})
              AND (meta IS NULL OR (meta->>'cannotPublish')::boolean IS NOT TRUE);
          `;
        }

        if (scheduledModels.length) {
          const scheduledModelIds = scheduledModels.map(({ id }) => id);

          await tx.$executeRaw`
          -- Make scheduled models published
          UPDATE "Model" 
          SET status = 'Published'
          WHERE id IN (${Prisma.join(scheduledModelIds)})
            AND status = 'Scheduled'
            AND "publishedAt" <= ${now}
            AND (meta IS NULL OR (meta->>'cannotPublish')::boolean IS NOT TRUE);
        `;
        }

        if (scheduledPosts.length) {
          const scheduledPostIds = scheduledPosts.map(({ id }) => id);

          await tx.$queryRaw<{ id: number }[]>`
          -- Update scheduled versions posts
          -- Respect prevPublishedAt metadata to preserve original date on republish
          UPDATE "Post" p
          SET
            "publishedAt" = CASE
              WHEN p."metadata"->>'prevPublishedAt' IS NOT NULL
              THEN (p."metadata"->>'prevPublishedAt')::timestamptz
              ELSE mv."publishedAt"
            END,
            "metadata" = p."metadata" - 'unpublishedAt' - 'unpublishedBy' - 'prevPublishedAt'
          FROM "ModelVersion" mv
          JOIN "Model" m ON m.id = mv."modelId"
          WHERE p.id IN (${Prisma.join(scheduledPostIds)})
            AND (p."publishedAt" IS NULL)
            AND mv.id = p."modelVersionId" AND m."userId" = p."userId"
            AND mv.status = 'Scheduled' AND mv."publishedAt" <= ${now}
            AND (m.meta IS NULL OR (m.meta->>'cannotPublish')::boolean IS NOT TRUE);
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
            UPDATE "ModelVersion" mv 
            SET status = 'Published', availability = 'Public'
            FROM "Model" m
            WHERE mv.id IN (${Prisma.join(scheduledModelVersions.map(({ id }) => id))})
              AND mv."modelId" = m.id
              AND mv.status = 'Scheduled'
              AND mv."publishedAt" <= ${now}
              AND (m.meta IS NULL OR (m.meta->>'cannotPublish')::boolean IS NOT TRUE);
          `;

          if (earlyAccess.length) {
            // The only downside to this failing is that the model version will be published with no early access.
            // Initially, I think this will be OK.
            await publishModelVersionsWithEarlyAccess({
              modelVersionIds: earlyAccess,
              continueOnError: true,
              tx,
            });

            // Update Model early access deadline in one operation
            await tx.$executeRaw`
              -- Update model early access deadline
              UPDATE "Model" mo
              SET "earlyAccessDeadline" = GREATEST(mea."earlyAccessDeadline", mo."earlyAccessDeadline")
              FROM (
                SELECT mv."modelId", mv."earlyAccessEndsAt" AS "earlyAccessDeadline"
                FROM "ModelVersion" mv
                WHERE mv.id IN (${Prisma.join(earlyAccess)})
              ) as mea
              WHERE mo."id" = mea."modelId"
                AND (mo.meta IS NULL OR (mo.meta->>'cannotPublish')::boolean IS NOT TRUE);
            `;
          }
        }
      },
      { timeout: 30000 }
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
      await bustMvCache(modelVersion.id, modelVersion.extras?.modelId);
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
