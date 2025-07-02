import { uniq } from 'lodash-es';
import { dbWrite } from '~/server/db/client';
import { dataForModelsCache } from '~/server/redis/caches';
import { bustMvCache } from '~/server/services/model-version.service';
import { createJob, getJobDate } from './job';

export const processingEngingEarlyAccess = createJob(
  'process-ending-early-access',
  '*/1 * * * *',
  async () => {
    // This job republishes early access versions that have ended as "New"
    const [, setLastRun] = await getJobDate('process-ending-early-access');

    const updated = await dbWrite.$queryRaw<{ id: number; modelId: number }[]>`
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
      RETURNING "id", "modelId"
    `;

    if (updated.length > 0) {
      const updatedIds = updated.map((v) => v.id);
      const modelIds = uniq(updated.map((v) => v.modelId));
      await bustMvCache(updatedIds, modelIds);
      await dataForModelsCache.bust(modelIds);
    }
    // Ensures user gets access to the resource after purchasing.

    await setLastRun();
  }
);
