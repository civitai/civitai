import { uniq } from 'lodash-es';
import { dbWrite } from '~/server/db/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dataForModelsCache } from '~/server/redis/caches';
import { modelsSearchIndex } from '~/server/search-index';
import { bustMvCache } from '~/server/services/model-version.service';
import { createJob, getJobDate } from './job';

export const processingEngingEarlyAccess = createJob(
  'process-ending-early-access',
  '*/1 * * * *',
  async () => {
    // The gate ends on its own: PaidAccess.endsAt is a materialized timestamp and reads derive
    // active-ness live, so we never delete or mutate the row here. This job's only remaining job is
    // to republish the version as "New" once, right after its timed gate elapses.
    //
    // Bounded to gates that ended since the last run (endsAt in (lastRun, now]) for an indexed scan.
    // Marker-free idempotency: after republish, publishedAt jumps to NOW() (past endsAt), so
    // `mv.publishedAt < pa.endsAt` no longer matches. Permanent/pending gates have endsAt NULL → excluded.
    const [lastRun, setLastRun] = await getJobDate('process-ending-early-access');

    const republished = await dbWrite.$queryRaw<{ id: number; modelId: number }[]>`
      UPDATE "ModelVersion" mv
      SET "publishedAt" = NOW(),
          "availability" = 'Public'
      FROM "PaidAccess" pa
      WHERE pa."entityType" = 'ModelVersion'
        AND pa."entityId" = mv.id
        AND pa."endsAt" > ${lastRun}
        AND pa."endsAt" <= NOW()
        AND mv."publishedAt" < pa."endsAt"
        AND mv.status = 'Published'
      RETURNING mv.id, mv."modelId"
    `;

    if (republished.length > 0) {
      const updatedIds = republished.map((v) => v.id);
      const modelIds = uniq(republished.map((v) => v.modelId));
      await bustMvCache(updatedIds, modelIds);
      await dataForModelsCache.refresh(modelIds);
      // Gate ended → re-index so the Meili document's derived early-access deadline clears.
      await modelsSearchIndex.queueUpdate(
        modelIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
      );
    }

    await setLastRun();
  }
);
