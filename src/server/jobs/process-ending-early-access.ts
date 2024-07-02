import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';

export const processingEngingEarlyAccess = createJob(
  'process-ending-early-access',
  '*/1 * * * *',
  async () => {
    // This job republishes early access versions that have ended as "New"
    const [, setLastRun] = await getJobDate('process-ending-early-access');

    await dbWrite.$queryRaw`
      UPDATE "ModelVersion"
      SET
        "earlyAccessConfig" = COALESCE("earlyAccessConfig", '{}'::jsonb) || JSONB_BUILD_OBJECT(
          'timeframe', 0,
          'originalPublishAt', "publishedAt"
          'originalTimeframe', "earlyAccessConfig"->>'timeframe'
        ),
        "earlyAccessEndsAt" = NULL,
        "publishedAt" = NOW(),
        "availability" = 'Public'
      WHERE status = 'Published'  
        AND "earlyAccessEndsAt" <= NOW()
        
    `;

    await setLastRun();
  }
);
