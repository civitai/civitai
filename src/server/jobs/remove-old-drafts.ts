import { createJob } from './job';
import { dbWrite } from '~/server/db/client';

export const removeOldDrafts = createJob('remove-old-drafts', '43 2 * * *', async () => {
  await dbWrite.$transaction(async (tx) => {
    // Permanently remove all drafts and deleted models that have not been updated in the last 30 days
    await tx.$executeRaw`
        DELETE FROM "Model" m
        WHERE m.id IN (
          SELECT DISTINCT m.id
          FROM "Model" m
          JOIN "ModelRank" mr ON mr."modelId" = m.id
          WHERE m.status IN ('Draft', 'Deleted')
          AND m."updatedAt" < now() - INTERVAL '30 days'
          AND mr."downloadCountAllTime" < 10
        );
      `;
  });
});
