import { dbWrite } from '~/server/db/client';
import { bustMvCache } from '~/server/services/model-version.service';
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
      await bustMvCache(updatedIds);
    }
    // Ensures user gets access to the resource after purchasing.

    await setLastRun();
  }
);
