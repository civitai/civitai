import { chunk } from 'lodash-es';
import * as z from 'zod';
import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import { metricsSearchClient } from '~/server/meilisearch/client';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Backfill for the scheduled-post `publishedAtUnix` drift (CU 868k2d05k bug C).
 *
 * A post that was scheduled (future publishedAt) goes live by wall-clock with no
 * DB write, so its images were never re-pulled into the metrics_images_v1 index
 * after publish. Their docs stay stub-shaped (no `publishedAtUnix`) and the feed
 * filter `publishedAtUnix <= now` excludes them — published but invisible. The
 * forward fix lives in updatePost; this heals the already-stuck backlog.
 *
 * Strategy:
 *   1. DB pre-filter (cheap, necessary condition for "stuck"): published, public,
 *      scanned images whose own `updatedAt` predates the post's `publishedAt`
 *      (i.e. nothing re-indexed them after go-live).
 *   2. Meili confirm (the real gate): keep only ids whose metrics doc is missing
 *      `publishedAtUnix`, so already-healed docs are not needlessly re-pulled.
 *   3. Re-queue the confirmed stubs through the durable search-index queue; the
 *      indexer re-pulls them with the now-published `publishedAt`.
 *
 * Dry-run by default. Trigger:
 *   /api/admin/temp/backfill-stuck-published-images?token=$WEBHOOK_TOKEN&dryRun=true
 *   ...&dryRun=false&publishedFrom=2026-05-01   (to actually queue)
 */
const schema = z.object({
  dryRun: booleanString().default(true),
  concurrency: z.coerce.number().min(1).max(10).default(5),
  batchSize: z.coerce.number().min(1).default(10000),
  start: z.coerce.number().min(0).default(0),
  end: z.coerce.number().min(0).optional(),
  // Only consider posts published on/after this date — the drift is recent and
  // older posts have self-healed; keeps the candidate id range bounded.
  publishedFrom: z.string().default('2026-04-01'),
  // Meili sub-batch size for the `publishedAtUnix NOT EXISTS` confirmation.
  meiliBatchSize: z.coerce.number().min(1).max(1000).default(500),
});

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);

  if (!metricsSearchClient) {
    res.status(500).json({ error: 'metricsSearchClient not configured' });
    return;
  }
  const index = metricsSearchClient.index(METRICS_IMAGES_SEARCH_INDEX);

  let totalCandidates = 0;
  let totalConfirmedStubs = 0;
  let totalQueued = 0;

  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async () => {
      // Bound the id range to images created from shortly before the publish
      // window (scheduled posts publish up to a few days after creation).
      // Avoid MIN(id) over a createdAt filter (full aggregation -> timeout):
      // the createdAt index makes `ORDER BY createdAt LIMIT 1` instant, and
      // MAX(id) is a PK lookup. Mirrors images.search-index prepareBatches.
      const [result] = await (
        await pgDbRead.cancellableQuery<{ start: number | null; end: number | null }>(
          `
          SELECT
            (
              SELECT id FROM "Image"
              WHERE "createdAt" >= $1::timestamptz - interval '14 days'
              ORDER BY "createdAt" ASC LIMIT 1
            ) as "start",
            (SELECT MAX(id) FROM "Image") as "end"
        `,
          [params.publishedFrom]
        )
      ).result();
      return { start: result?.start ?? 0, end: result?.end ?? 0 };
    },
    processor: async ({ start, end, cancelFns }) => {
      // 1. DB candidates: stuck-shaped published images in this id range.
      const fetchQuery = await pgDbRead.cancellableQuery<{ id: number }>(
        `
        SELECT i.id
        FROM "Image" i
        JOIN "Post" p ON p.id = i."postId"
        WHERE i.id >= $1 AND i.id <= $2
          AND p."publishedAt" >= $3::timestamptz
          AND p."publishedAt" <= now()
          AND p.availability NOT IN ('Private', 'Unsearchable')
          AND i.ingestion = 'Scanned'
          AND p."publishedAt" > i."updatedAt"
        `,
        [start, end, params.publishedFrom]
      );
      cancelFns.push(fetchQuery.cancel);
      const candidates = (await fetchQuery.result()).map((i) => i.id);
      if (!candidates.length) return;
      totalCandidates += candidates.length;

      // 2. Meili confirm: keep only ids whose doc is missing publishedAtUnix.
      const stubs: number[] = [];
      const subBatches = chunk(candidates, params.meiliBatchSize);
      await limitConcurrency(
        subBatches.map((sub) => async () => {
          const result = await index.search<{ id: number }>('', {
            filter: [`id IN [${sub.join(',')}]`, 'publishedAtUnix NOT EXISTS'],
            attributesToRetrieve: ['id'],
            limit: sub.length,
          });
          for (const hit of result.hits) stubs.push(hit.id);
        }),
        params.concurrency
      );
      if (!stubs.length) return;
      totalConfirmedStubs += stubs.length;

      console.log(
        `Range ${start}-${end}: ${candidates.length} candidates, ${stubs.length} confirmed stubs`
      );

      // 3. Re-queue confirmed stubs for re-index.
      if (params.dryRun) return;
      await queueImageSearchIndexUpdate({
        ids: stubs,
        action: SearchIndexUpdateQueueAction.Update,
      });
      totalQueued += stubs.length;
    },
  });

  res.status(200).json({
    finished: true,
    dryRun: params.dryRun,
    publishedFrom: params.publishedFrom,
    totalCandidates,
    totalConfirmedStubs,
    totalQueued,
  });
});
