import { Prisma } from '@prisma/client';
import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import orchestratorCaller from '~/server/http/orchestrator/orchestrator.caller';

type ScheduledEntity = {
  id: number;
  userId: number;
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
        m."userId"
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE mv.status = 'Scheduled' AND mv."publishedAt" <= ${now};
    `;
    const scheduledPosts = await dbWrite.$queryRaw<ScheduledEntity[]>`
      SELECT
        p.id,
        p."userId"
      FROM "Post" p
      JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE
        (p."publishedAt" IS NULL OR p.metadata->>'unpublishedAt' IS NOT NULL)
      AND mv.status = 'Scheduled' AND mv."publishedAt" <=  ${now};
    `;

    // Publish things
    const transaction = [
      dbWrite.$executeRaw`
      -- Update last version of scheduled models
      UPDATE "Model" SET "lastVersionAt" = ${now}
      WHERE id IN (
        SELECT
          mv."modelId"
        FROM "ModelVersion" mv
        WHERE status = 'Scheduled' AND "publishedAt" <= ${now}
      );`,
    ];

    if (scheduledModels.length) {
      const scheduledModelIds = scheduledModels.map(({ id }) => id);
      transaction.push(dbWrite.$executeRaw`
        -- Make scheduled models published
        UPDATE "Model" SET status = 'Published'
        WHERE id IN (${Prisma.join(scheduledModelIds)})
          AND status = 'Scheduled'
          AND "publishedAt" <= ${now};
      `);
    }

    if (scheduledPosts.length) {
      const scheduledPostIds = scheduledPosts.map(({ id }) => id);
      transaction.push(dbWrite.$executeRaw`
        -- Update scheduled versions posts
        UPDATE "Post" p SET "publishedAt" = mv."publishedAt"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE p.id IN (${Prisma.join(scheduledPostIds)})
          AND (p."publishedAt" IS NULL OR p.metadata->>'unpublishedAt' IS NOT NULL)
          AND mv.id = p."modelVersionId" AND m."userId" = p."userId"
          AND mv.status = 'Scheduled' AND mv."publishedAt" <=  ${now};
      `);
    }

    if (scheduledModelVersions.length) {
      const scheduledModelVersionIds = scheduledModelVersions.map(({ id }) => id);
      transaction.push(dbWrite.$executeRaw`
        -- Update scheduled versions published
        UPDATE "ModelVersion" SET status = 'Published'
        WHERE id IN (${Prisma.join(scheduledModelVersionIds)})
          AND status = 'Scheduled' AND "publishedAt" <= ${now};
      `);
    }

    await dbWrite.$transaction(transaction);

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
      await orchestratorCaller.bustModelCache({ modelVersionId: modelVersion.id });
    }
    for (const post of scheduledPosts) {
      await eventEngine.processEngagement({
        userId: post.userId,
        type: 'published',
        entityType: 'post',
        entityId: post.id,
      });
    }

    await setLastRun();
  }
);
