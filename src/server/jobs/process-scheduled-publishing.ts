import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import { NotificationCategory, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { POST_MINIMUM_SCHEDULE_MINUTES } from '~/server/common/constants';
import { uniq, uniqBy } from 'lodash-es';
import { dataForModelsCache, userImageVideoCountCaches } from '~/server/redis/caches';
import { firstDailyPostReward } from '~/server/rewards';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { modelsSearchIndex } from '~/server/search-index';
import {
  bustMvCache,
  publishModelVersionsWithEarlyAccess,
} from '~/server/services/model-version.service';
import { createNotification } from '~/server/services/notification.service';
import { updateComicNsfwLevels } from '~/server/services/nsfwLevels.service';
import { isDefined } from '~/utils/type-guards';
import { createJob, getJobDate } from './job';

type ScheduledEntity = {
  id: number;
  userId: number;
  extras?: { modelId: number; hasEarlyAccess?: boolean; earlyAccessEndsAt?: Date } & MixedObject;
};

// Ceiling on how far back the standalone-post reward sweep will look. The stored
// job date defaults to the epoch when the KeyValue row is missing (fresh env),
// which would otherwise sweep every post ever published.
const REWARD_LOOKBACK_LIMIT_MS = 60 * 60 * 1000;

export const processScheduledPublishing = createJob(
  'process-scheduled-publishing',
  '*/1 * * * *',
  async () => {
    const [lastRun, setLastRun] = await getJobDate('process-scheduled-publishing');
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
          'hasEarlyAccess', EXISTS (
            SELECT 1 FROM "PaidAccess" pa
            WHERE pa."entityType" = 'ModelVersion' AND pa."entityId" = mv.id
              AND pa."timeframeDays" IS NOT NULL
          ),
          'earlyAccessEndsAt', (
            SELECT pa."endsAt" FROM "PaidAccess" pa
            WHERE pa."entityType" = 'ModelVersion' AND pa."entityId" = mv.id
          )
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

    // Standalone scheduled posts go live passively once feeds stop filtering on
    // "publishedAt" — no status flips, so this window is the only publish-time hook.
    // The createdAt offset can't exclude a scheduled post (it's enforced at schedule
    // time); the instant publishes it lets through were already rewarded inline and
    // dedup by postId makes those a no-op.
    const rewardWindowStart = new Date(
      Math.max(lastRun.getTime(), now.getTime() - REWARD_LOOKBACK_LIMIT_MS)
    );
    const newlyLivePosts = await dbWrite.$queryRaw<{ id: number; userId: number }[]>`
      SELECT
        p.id,
        p."userId"
      FROM "Post" p
      WHERE p."publishedAt" > ${rewardWindowStart}
        AND p."publishedAt" <= ${now}
        AND p."publishedAt" >= p."createdAt" + ${Prisma.raw(
          `make_interval(mins => ${POST_MINIMUM_SCHEDULE_MINUTES})`
        )};
    `;

    // Get scheduled comic chapters
    const scheduledComicChapters = await dbWrite.$queryRaw<
      {
        projectId: number;
        position: number;
        userId: number;
        projectName: string;
        chapterName: string;
        username: string | null;
      }[]
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

        // Update NSFW levels — chapter recompute must complete before project
        // recompute or the project reads stale chapter levels.
        await updateComicNsfwLevels([projectId]).catch((e) =>
          console.error(`Failed to update NSFW levels for project ${projectId}:`, e)
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
          // Images are reindexed post-commit via queueImageSearchIndexUpdate
          // below — the db trigger's updatedAt bump isn't reliably picked up by
          // the metrics_images index.
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

    // Neither scheduled path reaches the inline reward in post.controller: the posts
    // flipped above had no publishedAt for it to fire on, and standalone ones skip it
    // at schedule time so the grant lands on the day they actually go live.
    for (const post of uniqBy([...scheduledPosts, ...newlyLivePosts], 'id')) {
      await firstDailyPostReward
        .apply({ postId: post.id, posterId: post.userId })
        .catch((error) =>
          console.error(`Failed to apply first daily post reward for post ${post.id}:`, error)
        );
    }

    // Reindex the just-published posts' images so the metrics_images feed picks
    // up their new sort position (GREATEST(publishedAt, scannedAt, createdAt)).
    if (scheduledPosts.length) {
      const images = await dbWrite.image.findMany({
        where: { postId: { in: scheduledPosts.map((p) => p.id) } },
        select: { id: true },
      });
      if (images.length) {
        await queueImageSearchIndexUpdate({
          ids: images.map((i) => i.id),
          action: SearchIndexUpdateQueueAction.Update,
        });
      }
      // This job publishes via raw SQL rather than updatePost, so it owns the
      // count refresh for the posts it flips.
      await userImageVideoCountCaches.refresh(uniq(scheduledPosts.map((p) => p.userId)));
    }

    const processedModelIds = [
      ...new Set([
        ...scheduledModels.map((entity) => entity.id),
        ...scheduledModelVersions.map((entity) => entity.extras?.modelId),
      ]),
    ].filter(isDefined);
    if (processedModelIds.length) {
      await dataForModelsCache.refresh(processedModelIds);
      await modelsSearchIndex.queueUpdate(
        processedModelIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
      );
    }

    await setLastRun();
  }
);
