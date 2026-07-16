import { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { checkNotUpToDate, dbKV, getCurrentLSN } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { sleep } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Backfill Image."sortAt" to the PG-authored feed sort key.
 *
 * This restates, for every historical row, the exact value the steady-state
 * triggers now write (packages/civitai-db-schema/prisma/programmability/
 * image_post_triggers.sql, PR #3168):
 *
 *   sortAt = GREATEST(post.publishedAt, image.scannedAt, image.createdAt)
 *
 * GREATEST ignores NULLs, so a draft / unpublished / postless image (no
 * publishedAt, resolved here by the LEFT JOIN yielding NULL) collapses to
 * GREATEST(scannedAt, createdAt); createdAt is NOT NULL so a value always
 * results. There is NO sentinel — this only fixes the sort *position*;
 * visibility is gated downstream (isPublished under the frozen BitDex engine).
 *
 * The previous body of this file used COALESCE(post.publishedAt, createdAt) with
 * NO scannedAt — the OLD, WRONG formula. It has been replaced wholesale.
 *
 * Semantics vs the old script:
 *   - Correct formula (adds scannedAt; GREATEST not COALESCE).
 *   - Skip-correct: the UPDATE writes only rows whose sortAt IS DISTINCT FROM the
 *     formula, so a second pass over an already-correct range does ZERO writes.
 *     This makes the job idempotent and cheap to re-run.
 *   - Does NOT bump updatedAt. This is a data correction; bumping updatedAt on
 *     105M rows would fan a re-index / change-emission storm. (The steady-state
 *     Post fan-out trigger DOES bump updatedAt on live publishes — that path is
 *     unaffected; only this bulk correction abstains.)
 *   - Sequential keyset cursor (not the concurrent dataProcessor): the concurrent
 *     scheduler completes id-ranges out of order, which is incompatible with a
 *     correct resumable high-water mark and with per-batch replica-lag gating.
 *     Both are required here, so the loop is explicit and ordered. The keyset
 *     shape (id-range windows, cancellableQuery) is retained from the original.
 *
 * Pacing / safety for a 105M-row table:
 *   - `sleepMs` between batches.
 *   - After each batch, wait for the read replicas to catch up (checkNotUpToDate)
 *     before issuing the next write, bounding replica lag. Capped by maxLagWaitMs.
 *   - Resumable: the last completed cursor is persisted in KeyValue under
 *     `PROGRESS_KEY`; a re-run with resume=true (default) continues from there.
 *
 * Dry-run by default — counts rows that WOULD change per batch, writes nothing.
 * Note: a dry run also honors the saved resume cursor, so after a partial apply it
 * estimates only the REMAINING id-range. For a full-table estimate pass
 * resume=false (dry runs never write the cursor, so this is safe).
 *
 * Trigger:
 *   /api/admin/temp/migrate-imageSortAt?token=$WEBHOOK_TOKEN                 (dry run)
 *   /api/admin/temp/migrate-imageSortAt?token=$WEBHOOK_TOKEN&dryRun=false    (apply)
 *   ...&dryRun=false&resume=false&start=0                                    (restart)
 */

const PROGRESS_KEY = 'backfill:image-sortat:v2';

const schema = z.object({
  dryRun: booleanString().default(true),
  // id-range width per batch (keyset window, not a row count).
  batchSize: z.coerce.number().min(1).max(5_000_000).default(50_000),
  // Milliseconds to sleep between batches (throttle write pressure).
  sleepMs: z.coerce.number().min(0).max(60_000).default(250),
  // Explicit lower bound. Omitted + resume=true → continue from saved cursor.
  start: z.coerce.number().min(0).optional(),
  // Explicit upper bound (inclusive). Omitted → MAX(id) at launch.
  end: z.coerce.number().min(0).optional(),
  // Continue from the persisted cursor when `start` is not given.
  resume: booleanString().default(true),
  // Gate the next batch on read-replica catch-up.
  lagCheck: booleanString().default(true),
  // Max time to wait for replicas per batch before proceeding anyway (ms).
  maxLagWaitMs: z.coerce.number().min(0).max(300_000).default(30_000),
});

type Progress = { cursor: number; updated: number; scanned: number; updatedAt: string };

export default WebhookEndpoint(async (req, res) => {
  console.time('IMAGE_SORTAT_BACKFILL');
  const result = await run(req);
  console.timeEnd('IMAGE_SORTAT_BACKFILL');
  res.status(200).json(result);
});

async function run(req: NextApiRequest) {
  const params = schema.parse(req.query);

  const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
    Prisma.sql`SELECT MAX(id)::int AS max FROM "Image";`
  );
  const end = params.end ?? max ?? 0;

  // Resume: explicit start wins; else saved cursor; else 0.
  const saved = params.resume ? await dbKV.get<Progress>(PROGRESS_KEY) : undefined;
  const start = params.start ?? saved?.cursor ?? 0;

  console.log(
    `[sortAt-backfill] start=${start} end=${end} batchSize=${params.batchSize} ` +
      `sleepMs=${params.sleepMs} dryRun=${params.dryRun} resume=${params.resume}` +
      (saved ? ` (resumed from cursor=${saved.cursor}, prior updated=${saved.updated})` : '')
  );

  let cursor = start;
  let totalScanned = saved && params.resume ? saved.scanned : 0;
  let totalUpdated = saved && params.resume ? saved.updated : 0;
  let batches = 0;

  while (cursor <= end) {
    const lo = cursor;
    const hi = Math.min(cursor + params.batchSize, end + 1); // [lo, hi)

    if (params.dryRun) {
      const { result } = await pgDbWrite.cancellableQuery<{ would: number }>(
        candidateCountSql(lo, hi)
      );
      const rows = await result();
      totalScanned += hi - lo;
      totalUpdated += Number(rows[0]?.would ?? 0);
    } else {
      const lsnBefore = await getCurrentLSN();
      const { result } = await pgDbWrite.cancellableQuery<{ id: number }>(updateSql(lo, hi));
      const rows = await result();
      totalScanned += hi - lo;
      totalUpdated += rows.length; // RETURNING i.id → one row per write

      // Persist progress after each committed batch so a crash/kill resumes here.
      await dbKV.set<Progress>(PROGRESS_KEY, {
        cursor: hi,
        updated: totalUpdated,
        scanned: totalScanned,
        updatedAt: new Date().toISOString(),
      });

      // Bound replica lag: don't start the next write until the replicas have
      // replayed this one (or we hit the cap).
      if (params.lagCheck && lsnBefore) {
        const waitStart = Date.now();
        while (
          (await checkNotUpToDate(lsnBefore)) &&
          Date.now() - waitStart < params.maxLagWaitMs
        ) {
          await sleep(500);
        }
        if (Date.now() - waitStart >= params.maxLagWaitMs) {
          console.warn(
            `[sortAt-backfill] replica lag > ${params.maxLagWaitMs}ms at cursor=${hi}; proceeding`
          );
        }
      }
    }

    batches++;
    if (batches % 20 === 0) {
      console.log(
        `[sortAt-backfill] cursor=${hi}/${end} scanned=${totalScanned} ${
          params.dryRun ? 'wouldUpdate' : 'updated'
        }=${totalUpdated}`
      );
    }

    cursor = hi;
    if (params.sleepMs > 0 && cursor <= end) await sleep(params.sleepMs);
  }

  const summary = {
    finished: true,
    dryRun: params.dryRun,
    start,
    end,
    batches,
    scanned: totalScanned,
    [params.dryRun ? 'wouldUpdate' : 'updated']: totalUpdated,
  };
  console.log('[sortAt-backfill] done', summary);
  return summary;
}

// GREATEST(post.publishedAt, image.scannedAt, image.createdAt), skip-correct.
// LEFT JOIN → NULL publishedAt for draft/postless images; GREATEST ignores it.
function updateSql(lo: number, hi: number) {
  return Prisma.sql`
    WITH batch AS (
      SELECT i.id,
             GREATEST(p."publishedAt", i."scannedAt", i."createdAt") AS new_sort_at
      FROM "Image" i
      LEFT JOIN "Post" p ON p.id = i."postId"
      WHERE i.id >= ${lo} AND i.id < ${hi}
    )
    UPDATE "Image" i
    SET "sortAt" = b.new_sort_at
    FROM batch b
    WHERE i.id = b.id
      AND i."sortAt" IS DISTINCT FROM b.new_sort_at
    RETURNING i.id
  `;
}

function candidateCountSql(lo: number, hi: number) {
  return Prisma.sql`
    SELECT COUNT(*)::int AS would
    FROM "Image" i
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE i.id >= ${lo} AND i.id < ${hi}
      AND i."sortAt" IS DISTINCT FROM GREATEST(p."publishedAt", i."scannedAt", i."createdAt")
  `;
}
