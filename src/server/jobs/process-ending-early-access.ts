import { dbWrite } from '~/server/db/client';
import { entityAccessCache } from '~/server/redis/caches';
import { bustOrchestratorModelCache } from '~/server/services/orchestrator/models';
import { createJob, getJobDate } from './job';

export const processingEngingEarlyAccess = createJob(
  'process-ending-early-access',
  '*/1 * * * *',
  async () => {
    // This job republishes early access versions that have ended as "New"
    const [, setLastRun] = await getJobDate('process-ending-early-access');

    const updated = await dbWrite.$queryRaw<{ id: number }[]>`
      UPDATE "ModelVersion"
      SET "earlyAccessConfig" = 
          COALESCE("earlyAccessConfig", '{}'::jsonb)  || JSONB_BUILD_OBJECT(
            'timeframe', 0,
            'originalPublishedAt', "publishedAt",
            'originalTimeframe', "earlyAccessConfig"->>'timeframe'
          ),
        "earlyAccessEndsAt" = NULL,
        "publishedAt" = NOW(),
        "availability" = 'Public'
      WHERE status = 'Published'  
        AND "earlyAccessEndsAt" <= NOW()
      RETURNING "id"
    `;

    if (updated.length > 0) {
      const updatedIds = updated.map((v) => v.id);
      await bustOrchestratorModelCache(updatedIds);
      await entityAccessCache.bust(updatedIds);
      // TODO need resourceDataCache.bust?
    }
    // Ensures user gets access to the resource after purchasing.

    await setLastRun();
  }
);
