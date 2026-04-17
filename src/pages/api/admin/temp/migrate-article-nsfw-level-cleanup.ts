import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { pgDbRead } from '~/server/db/pgDb';
import { dbWrite } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';
import { updateArticleNsfwLevels } from '~/server/services/nsfwLevels.service';

// One-shot cleanup for the Article.nsfw deprecation (2026-04-17).
//
// Before: `updateArticleNsfwLevels`' CASE WHEN forced `nsfwLevel = 60`
// (R|X|XXX|Blocked = `nsfwBrowsingLevelsFlag`) whenever `a.nsfw = TRUE`.
// Setting the Blocked bit on a non-blocked article was a latent bug —
// blocking is tracked via `ArticleStatus.UnpublishedViolation`, not via
// the nsfwLevel mask.
//
// After the rewrite, `updateArticleNsfwLevels` treats text moderation
// and Actioned NSFW reports as a durable R floor via EXISTS subqueries.
// This migration re-derives legacy `nsfwLevel = 60` rows to the correct
// value by:
//
//   1. Zeroing any `userNsfwLevel = 60` artifact. A composite-mask value
//      in `userNsfwLevel` can only come from the upsertArticle auto-clamp
//      (Math.max(userNsfwLevel, article.nsfwLevel)), since users pick
//      single tiers (1/2/4/8/16) from the form. Leaving it would trap
//      the article at 60 forever even after we reset `nsfwLevel`.
//   2. Zeroing `nsfwLevel` on the same rows so the service's GREATEST
//      recomputes from image + user + moderation-floor ground truth
//      instead of re-inheriting the 60.
//   3. Calling `updateArticleNsfwLevels` — the EntityModeration and
//      NSFW-report subqueries pick up the R floor for any article that
//      was text-flagged or reported, so text-only-flagged articles with
//      PG images land at R exactly.
//
// `article.nsfw = TRUE` is left in place as a historical trace.

type CancelFn = () => Promise<void>;

const log = createLogger('migrate-article-nsfw-level-cleanup', 'blue');

type Stats = {
  articlesProcessed: number;
  userNsfwLevelsReset: number;
  articlesUpdated: number;
};

const querySchema = z.object({
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(5000).default(500),
  start: z.coerce.number().optional().default(0),
  end: z.coerce.number().optional(),
});

type Params = z.infer<typeof querySchema>;

async function fetchMaxArticleId(cancelFns: CancelFn[]) {
  const query = await pgDbRead.cancellableQuery<{ max: number | null }>(Prisma.sql`
    SELECT MAX(id) "max" FROM "Article" WHERE "nsfwLevel" = 60 AND nsfw = TRUE
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
    `Starting nsfwLevel cleanup${params.dryRun ? ' (DRY RUN)' : ''} ` +
      `batchSize=${params.batchSize} start=${params.start} end=${params.end ?? 'auto'}`
  );

  const stats: Stats = {
    articlesProcessed: 0,
    userNsfwLevelsReset: 0,
    articlesUpdated: 0,
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
    const maxId = params.end ?? (await fetchMaxArticleId(cancelFns));
    if (maxId === 0) {
      log('No articles match nsfwLevel=60 AND nsfw=TRUE — nothing to do');
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

      const idsQuery = await pgDbRead.cancellableQuery<{ id: number }>(Prisma.sql`
        SELECT id FROM "Article"
        WHERE "nsfwLevel" = 60
          AND nsfw = TRUE
          AND id >= ${cursor}
          AND id <= ${maxId}
        ORDER BY id ASC
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
        // Step 1: clear auto-clamp artifacts in userNsfwLevel. Safe because
        // users only ever pick single-tier values from the form (1/2/4/8/16),
        // so a literal 60 can only be the Math.max auto-clamp output.
        const clampReset = await dbWrite.$executeRaw(Prisma.sql`
          UPDATE "Article"
          SET "userNsfwLevel" = 0
          WHERE id IN (${Prisma.join(ids)}) AND "userNsfwLevel" = 60
        `);
        stats.userNsfwLevelsReset += Number(clampReset);

        // Step 2: clear the buggy 60 so the service's GREATEST recomputes
        // from image + user + moderation-floor ground truth.
        await dbWrite.$executeRaw(Prisma.sql`
          UPDATE "Article"
          SET "nsfwLevel" = 0
          WHERE id IN (${Prisma.join(ids)}) AND "nsfwLevel" = 60 AND nsfw = TRUE
        `);

        // Step 3: recompute. EntityModeration + Report subqueries inside
        // the service apply the R floor for any article that was text-flagged
        // or reported. The service also queues the search index.
        await updateArticleNsfwLevels(ids);
        stats.articlesUpdated += ids.length;
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
          `userLevelResets=${stats.userNsfwLevelsReset} | ` +
          `progress=${progressPct}% (id ${cursor}/${maxId}) | rate=${rate.toFixed(1)}/s | ` +
          `elapsed=${elapsedSec.toFixed(1)}s`
      );
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Cleanup completed in ${duration}s${stopped ? ' (stopped early)' : ''}`);

    res.status(200).json({
      ok: true,
      dryRun: params.dryRun,
      stopped,
      duration: `${duration}s`,
      result: stats,
    });
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Cleanup failed after ${duration}s:`, error);

    res.status(500).json({
      ok: false,
      error: (error as Error).message,
      stack: (error as Error).stack,
    });
  }
});
