import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { pgDbRead } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';
import { updateArticleNsfwLevels } from '~/server/services/nsfwLevels.service';

// One-shot backfill for the cover-image nsfwLevel leak (2026-04-21).
//
// `fanOutArticleImageUpdates` historically only looked at `ImageConnection`
// rows, so cover scans (stored on `Article.coverId`) never triggered a
// recompute of `Article.nsfwLevel`. That left articles with the
// author-declared `userNsfwLevel` (often PG/PG13) even when the cover ended
// up rated R/X/XXX/Blocked — and those articles then passed the
// `(a."nsfwLevel" & browsingLevel) != 0` SFW feed filter on civitai.com.
//
// The forward fix (webhook-debounce.ts + SQL derivation) is in place; this
// migration reconciles the historical drift by running
// `updateArticleNsfwLevels` on every article whose stored `nsfwLevel` is
// smaller than what the service would now compute.
//
// The candidate query intentionally mirrors the derivation SQL: `GREATEST`
// of userNsfwLevel, cover.nsfwLevel (Scanned or Blocked), and content image
// nsfwLevel. If that value exceeds `a."nsfwLevel"`, the article is stale
// and gets queued for recompute. The service handles moderation floors and
// search-index updates itself.
//
// Scoped to `status = 'Published'` because only published articles reach the
// public feed — those are the ones that can leak. Drafts, Unpublished, and
// Processing articles don't need reconciling here; upsertArticle now runs
// `updateArticleImageScanStatus` on every save/publish, so any of those will
// re-derive nsfwLevel from ground truth the moment they transition to
// Published.

type CancelFn = () => Promise<void>;

const log = createLogger('migrate-article-nsfw-cover-sync', 'blue');

type Stats = {
  articlesProcessed: number;
  articlesUpdated: number;
  articlesSkipped: number;
};

const querySchema = z.object({
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(5000).default(500),
  start: z.coerce.number().optional().default(0),
  end: z.coerce.number().optional(),
});

type Params = z.infer<typeof querySchema>;

async function fetchMaxCandidateId(cancelFns: CancelFn[]) {
  // Wrap the per-article HAVING query in an outer MAX. Without the subquery the
  // outer `SELECT MAX(a.id)` collapses into the GROUP BY and returns one row
  // per stale article — then `results[0].max` is whatever id Postgres
  // happened to emit first, so the batch loop caps at a tiny id range and
  // silently skips every stale article above it.
  const query = await pgDbRead.cancellableQuery<{ max: number | null }>(Prisma.sql`
    SELECT MAX(stale.id) AS "max"
    FROM (
      SELECT a.id
      FROM "Article" a
      LEFT JOIN "Image" cover
        ON a."coverId" = cover.id
        AND cover."ingestion" IN ('Scanned', 'Blocked')
      LEFT JOIN "ImageConnection" ic
        ON ic."entityId" = a.id AND ic."entityType" = 'Article'
      LEFT JOIN "Image" content_imgs
        ON ic."imageId" = content_imgs.id
        AND content_imgs."ingestion" = 'Scanned'
      WHERE a."coverId" IS NOT NULL
        AND a.status = 'Published'
      GROUP BY a.id, a."nsfwLevel", a."userNsfwLevel"
      HAVING GREATEST(
        a."userNsfwLevel",
        COALESCE(max(cover."nsfwLevel"), 0),
        COALESCE(max(content_imgs."nsfwLevel"), 0)
      ) > a."nsfwLevel"
    ) stale
  `);
  cancelFns.push(query.cancel);
  const results = await query.result();
  return results[0]?.max ?? 0;
}

export default WebhookEndpoint(async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: z.treeifyError(parsed.error) });
  }

  const params: Params = parsed.data;
  const startTime = Date.now();

  log(
    `Starting cover-sync backfill${params.dryRun ? ' (DRY RUN)' : ''} ` +
      `batchSize=${params.batchSize} start=${params.start} end=${params.end ?? 'auto'}`
  );

  const stats: Stats = {
    articlesProcessed: 0,
    articlesUpdated: 0,
    articlesSkipped: 0,
  };

  const cancelFns: CancelFn[] = [];
  let stopped = false;
  res.on('close', async () => {
    stopped = true;
    log(`Client disconnected, cancelling ${cancelFns.length} in-flight query(ies)...`);
    await Promise.all(
      cancelFns.map((cancel) =>
        cancel().catch((err) => log(`Cancel failed: ${(err as Error).message}`))
      )
    );
  });

  try {
    const maxId = params.end ?? (await fetchMaxCandidateId(cancelFns));
    if (maxId === 0) {
      log('No articles have stale nsfwLevel relative to their cover — nothing to do');
      res.status(200).json({ ok: true, dryRun: params.dryRun, duration: '0.00s', result: stats });
      return;
    }

    const rangeStart = params.start;
    const rangeSize = Math.max(1, maxId - rangeStart + 1);
    let cursor = rangeStart;
    let batchNumber = 0;

    while (!stopped && cursor <= maxId) {
      batchNumber++;
      const batchStart = Date.now();

      // Each batch re-queries candidates in the current id window. Rows that
      // a previous batch already fixed (via `updateArticleNsfwLevels` in
      // `!dryRun` mode) drop out of the HAVING clause on the next pass, so we
      // can't re-hit them. Dry runs see the same row twice if the batch
      // window overlaps; the cursor advance below prevents that.
      const idsQuery = await pgDbRead.cancellableQuery<{ id: number }>(Prisma.sql`
        SELECT a.id
        FROM "Article" a
        LEFT JOIN "Image" cover
          ON a."coverId" = cover.id
          AND cover."ingestion" IN ('Scanned', 'Blocked')
        LEFT JOIN "ImageConnection" ic
          ON ic."entityId" = a.id AND ic."entityType" = 'Article'
        LEFT JOIN "Image" content_imgs
          ON ic."imageId" = content_imgs.id
          AND content_imgs."ingestion" = 'Scanned'
        WHERE a."coverId" IS NOT NULL
          AND a.status = 'Published'
          AND a.id >= ${cursor}
          AND a.id <= ${maxId}
        GROUP BY a.id, a."nsfwLevel", a."userNsfwLevel"
        HAVING GREATEST(
          a."userNsfwLevel",
          COALESCE(max(cover."nsfwLevel"), 0),
          COALESCE(max(content_imgs."nsfwLevel"), 0)
        ) > a."nsfwLevel"
        ORDER BY a.id ASC
        LIMIT ${params.batchSize}
      `);
      cancelFns.push(idsQuery.cancel);

      let rows: { id: number }[];
      try {
        rows = await idsQuery.result();
      } catch (error) {
        if (stopped) break;
        throw error;
      }

      if (rows.length === 0) {
        log(`[batch ${batchNumber}] No more candidates — done`);
        break;
      }

      const ids = rows.map((r) => r.id);
      const firstId = ids[0];
      const lastId = ids[ids.length - 1];
      log(
        `[batch ${batchNumber}] ${rows.length} candidates (IDs ${firstId}-${lastId})` +
          (params.dryRun ? ' (DRY RUN — no writes)' : '')
      );

      if (!params.dryRun) {
        // Service computes GREATEST(userNsfwLevel, cover, content, moderation
        // floor) and skips the UPDATE when the derived value already equals
        // the stored one — so re-running on already-correct articles is a
        // cheap no-op.
        await updateArticleNsfwLevels(ids);
        stats.articlesUpdated += ids.length;
      } else {
        stats.articlesSkipped += ids.length;
      }

      stats.articlesProcessed += ids.length;
      cursor = lastId + 1;

      const batchDuration = Date.now() - batchStart;
      const elapsedSec = (Date.now() - startTime) / 1000;
      const progressPct = Math.min(
        100,
        Math.max(0, ((cursor - rangeStart) / rangeSize) * 100)
      ).toFixed(1);
      const rate = stats.articlesProcessed / Math.max(elapsedSec, 0.001);

      log(
        `[batch ${batchNumber}] done in ${batchDuration}ms | ` +
          `totals: processed=${stats.articlesProcessed} updated=${stats.articlesUpdated} ` +
          `skipped=${stats.articlesSkipped} | ` +
          `progress=${progressPct}% (id ${cursor}/${maxId}) | rate=${rate.toFixed(1)}/s | ` +
          `elapsed=${elapsedSec.toFixed(1)}s`
      );
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Backfill completed in ${duration}s${stopped ? ' (stopped early)' : ''}`);

    res.status(200).json({
      ok: true,
      dryRun: params.dryRun,
      stopped,
      duration: `${duration}s`,
      result: stats,
    });
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Backfill failed after ${duration}s:`, error);

    res.status(500).json({
      ok: false,
      error: (error as Error).message,
      stack: (error as Error).stack,
    });
  }
});
