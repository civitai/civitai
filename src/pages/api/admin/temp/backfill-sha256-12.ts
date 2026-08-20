/**
 * Backfill `SHA256_12` rows for files scanned before `normalizeScanHashes()` shipped.
 * =============================================================================
 *
 * Hidden admin route. Guarded by WEBHOOK_TOKEN via `?token=` query param, the same as every
 * other endpoint in this directory.
 *
 * ## Why
 *
 * A1111/Forge write `sha256[0:12]` into image metadata for LoRAs. `AutoV2` is `sha256[0:10]`
 * and `AutoV3` is a different (tensor-only) algorithm, so no stored width matched that value
 * and resource detection silently failed. Migration `20260819000000_model_file_hash_sha256_12`
 * added the enum value; `normalizeScanHashes()` derives the row on the SCAN path.
 *
 * The scan path only covers files scanned AFTER that release. The pre-existing corpus never
 * gets a row and is not self-healing. This endpoint closes that gap.
 *
 * ## How
 *
 * Derived entirely from stored `SHA256` rows — no file access, no orchestrator, no re-scan.
 * Each hash is passed through `normalizeScanHashes()` rather than truncated here, so this
 * writer inherits the same rules as the scan path (including the all-zero sentinel guard
 * below) and cannot drift from it. See the writer ledger in
 * src/server/services/__tests__/model-file-hash-writers.test.ts.
 *
 * 🔴 The all-zero `SHA256` is the "file unreachable" sentinel. Deriving from it would give
 * every such file the SAME 12-char hash, so they would all match each other. It is
 * `normalizeScanHashes()` that suppresses it — this endpoint gets that for free by calling the
 * helper, and would reintroduce the bug the moment it truncated inline instead.
 *
 * Idempotent: `createMany({ skipDuplicates: true })` compiles to
 * `ON CONFLICT ("fileId", type) DO NOTHING` against the `ModelFileHash_pkey` on
 * `("fileId", type)` — the table's only unique constraint. A second run over the same range
 * writes nothing and reports `written: 0`.
 *
 * ## Cost of a full run, and how to resume
 *
 * The scan is a `fileId`-ordered walk of `type='SHA256'` rows. As of 2026-08-20 production
 * holds 1,489,384 such rows, so a full pass reads ~1.49M rows and writes at most one row per
 * file (~400 MB at full corpus width). At the default `batchSize=1000` that is ~1,490 batches;
 * `maxBatches` caps a single invocation at 100 batches (~100k files) so one call cannot run
 * unbounded against production.
 *
 * A run therefore does NOT finish the corpus by default. The response reports:
 *
 *   complete   - true when the range was exhausted, false when `maxBatches` stopped it early
 *   lastCursor - the next `fileId` to start from
 *
 * Resume by passing `start=<lastCursor>` and calling again until `complete: true`. Because the
 * write is idempotent, re-running an already-processed range is safe and costs only the read.
 *
 * ⚠️ Start with `dryRun=true` (the default) to see the scale before writing. Dry run performs
 * an extra lookup per batch to count rows that genuinely lack a `SHA256_12` sibling, so its
 * `candidates` is the real number of writes a live run would make — not the row count scanned.
 *
 * Usage:
 *   GET /api/admin/temp/backfill-sha256-12?token=$WEBHOOK_TOKEN
 *   GET /api/admin/temp/backfill-sha256-12?token=$WEBHOOK_TOKEN&dryRun=false&start=123456
 *
 * Params (query):
 *   dryRun     - default true. Report candidates without writing.
 *   batchSize  - default 1000, max 5000. SHA256 rows per page.
 *   maxBatches - default 100, max 10000. Hard bound on batches per invocation.
 *   start      - default 0. Minimum ModelFile id to consider (resume point).
 *   end        - optional. Maximum ModelFile id to consider.
 */

import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import { normalizeScanHashes } from '~/server/services/model-file-scan.service';
import { ModelHashType } from '~/shared/utils/prisma/enums';
import { WebhookEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';

const log = createLogger('backfill-sha256-12', 'cyan');

const querySchema = z.object({
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(5000).default(1000),
  maxBatches: z.coerce.number().min(1).max(10000).default(100),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().optional(),
});

type Stats = {
  /** SHA256 rows read. */
  scanned: number;
  /** Rows normalizeScanHashes produced a SHA256_12 for. */
  derivable: number;
  /**
   * Rows it did NOT — the all-zero "file unreachable" sentinel. Reported separately because a
   * non-zero value here is the guard doing its job, not an error.
   */
  skippedSentinel: number;
  /** Dry run only: derivable rows with no existing SHA256_12 sibling. */
  candidates: number;
  /** Live run only: rows the database actually inserted, after ON CONFLICT DO NOTHING. */
  written: number;
  batches: number;
};

export default WebhookEndpoint(async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: z.treeifyError(parsed.error) });
  }
  const params = parsed.data;
  const startTime = Date.now();
  const stats: Stats = {
    scanned: 0,
    derivable: 0,
    skippedSentinel: 0,
    candidates: 0,
    written: 0,
    batches: 0,
  };

  let cursor = params.start;
  let complete = false;

  try {
    log(
      `Starting${params.dryRun ? ' (DRY RUN)' : ''} | batchSize=${params.batchSize} ` +
        `maxBatches=${params.maxBatches} start=${params.start} end=${params.end ?? 'MAX'}`
    );

    while (stats.batches < params.maxBatches) {
      const rows = await dbRead.modelFileHash.findMany({
        where: {
          type: ModelHashType.SHA256,
          fileId: { gte: cursor, ...(params.end !== undefined && { lte: params.end }) },
        },
        select: { fileId: true, hash: true },
        orderBy: { fileId: 'asc' },
        take: params.batchSize,
      });

      if (rows.length === 0) {
        complete = true;
        break;
      }

      stats.batches++;
      stats.scanned += rows.length;
      const firstId = rows[0].fileId;
      const lastId = rows[rows.length - 1].fileId;

      // The derivation. Deliberately NOT `hash.slice(0, 12)` — the helper owns the rules,
      // including suppressing the all-zero sentinel, and it is the same call the scan path
      // makes. Re-implementing it here is the exact drift the writer ledger exists to catch.
      const toWrite: { fileId: number; type: ModelHashType; hash: string }[] = [];
      for (const row of rows) {
        const derived = normalizeScanHashes({ [ModelHashType.SHA256]: row.hash }).SHA256_12;
        if (!derived) {
          stats.skippedSentinel++;
          continue;
        }
        stats.derivable++;
        toWrite.push({ fileId: row.fileId, type: ModelHashType.SHA256_12, hash: derived });
      }

      if (toWrite.length > 0) {
        if (params.dryRun) {
          // Count what a live run would insert, rather than assuming every derivable row is a
          // write. Most of the corpus may already be covered, and reporting `derivable` as the
          // write volume would overstate the job to whoever is deciding whether to run it.
          const existing = await dbRead.modelFileHash.findMany({
            where: {
              type: ModelHashType.SHA256_12,
              fileId: { in: toWrite.map((r) => r.fileId) },
            },
            select: { fileId: true },
          });
          const covered = new Set(existing.map((r) => r.fileId));
          stats.candidates += toWrite.filter((r) => !covered.has(r.fileId)).length;
        } else {
          // skipDuplicates -> ON CONFLICT ("fileId", type) DO NOTHING. `count` is what the
          // database really inserted, so a re-run over covered ground reports 0 rather than
          // restating the candidate count.
          const result = await dbWrite.modelFileHash.createMany({
            data: toWrite,
            skipDuplicates: true,
          });
          stats.written += result.count;
        }
      }

      const elapsedSec = (Date.now() - startTime) / 1000;
      log(
        `[batch ${stats.batches} | fileId ${firstId}-${lastId}] ${rows.length} scanned | ` +
          `totals: ${stats.scanned} seen, ${stats.derivable} derivable, ` +
          `${stats.skippedSentinel} sentinel, ` +
          `${params.dryRun ? `${stats.candidates} candidates` : `${stats.written} written`} | ` +
          `elapsed: ${elapsedSec.toFixed(1)}s | resume with start=${lastId + 1}`
      );

      cursor = lastId + 1;
      if (params.end !== undefined && cursor > params.end) {
        complete = true;
        break;
      }
      // A short page means the range is exhausted; asking for another would return nothing.
      if (rows.length < params.batchSize) {
        complete = true;
        break;
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(
      `${
        complete ? 'Completed' : `Stopped at the ${params.maxBatches}-batch bound`
      } in ${duration}s` + `${complete ? '' : ` — resume with start=${cursor}`}`
    );

    res.status(200).json({
      ok: true,
      dryRun: params.dryRun,
      duration: `${duration}s`,
      complete,
      lastCursor: cursor,
      result: stats,
    });
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    // The resume point is the operationally important half of a failure here, and it goes to the
    // log rather than the response body: `handleEndpointError` is the shared 500 chokepoint
    // (civitai#3845) and deliberately does not echo error text, because a driver error's own
    // message carries the table/column — or, for a 23505, the offending row value.
    log(
      `Failed after ${duration}s — resume with start=${cursor} | ` +
        `stats=${JSON.stringify(stats)}`,
      error
    );
    return handleEndpointError(res, error);
  }
});
