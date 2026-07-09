import { chunk } from 'lodash-es';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { executeRefresh, getAffected } from '~/server/metrics/metric-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:comic');
const BATCH_SIZE = 1000;

// Comic counter rollup into ComicProjectMetric. Incremental: only comics whose
// source rows changed since the last run are recomputed (the `getAffected`
// pattern the other modules use). Every comic counter is Postgres-sourced — there
// is no ClickHouse read path left for comics.
//
//   - tips      ← BuzzTip (entityType = 'ComicProject')
//   - followers ← ComicProjectEngagement type = 'Notify'
//   - hides     ← ComicProjectEngagement type = 'Hide'
//   - readers   ← ComicChapterRead (distinct users, unread = false)
//   - reads     ← ComicChapterRead (rows, unread = false)
//
// Removals stay detectable because both un-follows and un-reads soft-delete
// (`ComicProjectEngagement.type = 'None'`, `ComicChapterRead.unread = true`) and
// bump their row's `updatedAt`, so they're picked up here — avoiding the
// dormant-entity drift the hard-delete engagement tables (Article/Model) suffer.
export const comicProjectMetrics = createMetricProcessor({
  name: 'ComicProject',
  async update(ctx) {
    const affected = await getAffectedComics(ctx);
    log('comicProjectMetrics update', affected.length, 'comics');
    if (!affected.length) return;

    const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
      ctx.jobContext.checkIfCanceled();
      log('update metrics', i + 1, 'of', tasks.length);
      await executeRefresh(ctx)`
        INSERT INTO "ComicProjectMetric" (
          "comicProjectId", "updatedAt",
          "tippedCount", "tippedAmountCount", "followerCount", "hiddenCount",
          "readerCount", "chapterReadCount"
        )
        SELECT
          cp.id,
          NOW(),
          COALESCE(t."tippedCount", 0),
          COALESCE(t."tippedAmountCount", 0),
          COALESCE(e."followerCount", 0),
          COALESCE(e."hiddenCount", 0),
          COALESCE(rd."readerCount", 0),
          COALESCE(rd."chapterReadCount", 0)
        FROM "ComicProject" cp
        LEFT JOIN (
          SELECT
            "entityId" AS id,
            COUNT(*)::int AS "tippedCount",
            COALESCE(SUM(amount), 0)::int AS "tippedAmountCount"
          FROM "BuzzTip"
          WHERE "entityType" = 'ComicProject' AND "entityId" = ANY(${ids}::int[])
          GROUP BY "entityId"
        ) t ON t.id = cp.id
        LEFT JOIN (
          SELECT
            "projectId" AS id,
            COUNT(*) FILTER (WHERE type = 'Notify'::"ComicEngagementType")::int AS "followerCount",
            COUNT(*) FILTER (WHERE type = 'Hide'::"ComicEngagementType")::int AS "hiddenCount"
          FROM "ComicProjectEngagement"
          WHERE "projectId" = ANY(${ids}::int[])
          GROUP BY "projectId"
        ) e ON e.id = cp.id
        LEFT JOIN (
          SELECT
            cc."projectId" AS id,
            COUNT(DISTINCT cr."userId")::int AS "readerCount",
            COUNT(*)::int AS "chapterReadCount"
          FROM "ComicChapterRead" cr
          JOIN "ComicChapter" cc ON cc.id = cr."chapterId"
          WHERE cr."unread" = false AND cc."projectId" = ANY(${ids}::int[])
          GROUP BY cc."projectId"
        ) rd ON rd.id = cp.id
        WHERE cp.id = ANY(${ids}::int[])
        ON CONFLICT ("comicProjectId") DO UPDATE
          SET
            "tippedCount" = EXCLUDED."tippedCount",
            "tippedAmountCount" = EXCLUDED."tippedAmountCount",
            "followerCount" = EXCLUDED."followerCount",
            "hiddenCount" = EXCLUDED."hiddenCount",
            "readerCount" = EXCLUDED."readerCount",
            "chapterReadCount" = EXCLUDED."chapterReadCount",
            "updatedAt" = NOW()
      `;
      log('update metrics', i + 1, 'of', tasks.length, 'done');
    });

    await limitConcurrency(tasks, 5);
    log('comicProjectMetrics update done');
  },
});

// Comics whose tips OR engagement changed since the last run.
async function getAffectedComics(ctx: MetricProcessorRunContext) {
  const tipIds = await getAffected(ctx)`
    -- comics with recent tip activity
    SELECT "entityId" AS id
    FROM "BuzzTip"
    WHERE "entityType" = 'ComicProject'
      AND ("createdAt" > ${ctx.lastUpdate} OR "updatedAt" > ${ctx.lastUpdate})
  `;
  const engagementIds = await getAffected(ctx)`
    -- comics with recent follow/hide/unfollow activity (soft-deletes bump updatedAt)
    SELECT "projectId" AS id
    FROM "ComicProjectEngagement"
    WHERE "updatedAt" > ${ctx.lastUpdate}
  `;
  const readIds = await getAffected(ctx)`
    -- comics with recent read/unread activity (un-reads soft-delete + bump updatedAt)
    SELECT cc."projectId" AS id
    FROM "ComicChapterRead" cr
    JOIN "ComicChapter" cc ON cc.id = cr."chapterId"
    WHERE cr."updatedAt" > ${ctx.lastUpdate}
  `;
  return [...new Set([...tipIds, ...engagementIds, ...readIds])];
}
