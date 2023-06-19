import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';

export const processScheduledPublishing = createJob(
  'process-scheduled-publishing',
  '*/1 * * * *',
  async () => {
    const [lastRun, setLastRun] = await getJobDate('process-scheduled-publishing');

    const now = new Date();

    await dbWrite.$transaction([
      dbWrite.$executeRaw`
      -- Make scheduled models published
      UPDATE "Model" SET status = 'Published'
      WHERE status = 'Scheduled' AND "publishedAt" < ${now};`,
      dbWrite.$executeRaw`
      -- Update last version of scheduled models
      UPDATE "Model" SET "lastVersionAt" = ${now}
      WHERE id IN (
        SELECT
          mv."modelId"
        FROM "ModelVersion" mv
        WHERE status = 'Scheduled' AND "publishedAt" < ${now}
      );`,
      dbWrite.$executeRaw`
      -- Update scheduled versions published
      UPDATE "ModelVersion" SET status = 'Published'
      WHERE status = 'Scheduled' AND "publishedAt" < ${now};`,
    ]);

    await setLastRun();
  }
);
