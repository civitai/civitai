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

    // Reconciliation pass. The republish above is a ONE-SHOT: its `mv.publishedAt < pa.endsAt`
    // guard stops matching the moment publishedAt is bumped, so anything that resets availability
    // afterwards strands the version at 'EarlyAccess' forever and the version silently stops being
    // downloadable for everyone but moderators. Sweep for expired gates that are still flagged,
    // regardless of the lastRun window, so a single lost update self-corrects on the next tick.
    //
    // Deliberately does NOT touch publishedAt — these versions were already republished, and
    // re-bumping it would resurface them as "New" and re-fire anything keyed on publishedAt.
    // Driven off PaidAccess (small, indexed on (entityType, endsAt)) rather than a scan of
    // ModelVersion for availability.
    const reconciled = await dbWrite.$queryRaw<{ id: number; modelId: number }[]>`
      UPDATE "ModelVersion" mv
      SET "availability" = 'Public'
      FROM "PaidAccess" pa
      WHERE pa."entityType" = 'ModelVersion'
        AND pa."entityId" = mv.id
        AND pa."endsAt" IS NOT NULL
        AND pa."endsAt" <= NOW()
        AND mv."availability" = 'EarlyAccess'
        AND mv.status = 'Published'
      RETURNING mv.id, mv."modelId"
    `;

    const updated = [...republished, ...reconciled];
    if (updated.length > 0) {
      const updatedIds = uniq(updated.map((v) => v.id));
      const modelIds = uniq(updated.map((v) => v.modelId));
      await bustMvCache(updatedIds, modelIds);
      await dataForModelsCache.refresh(modelIds);
      await modelsSearchIndex.queueUpdate(
        modelIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
      );
    }

    await setLastRun();
  }
);
