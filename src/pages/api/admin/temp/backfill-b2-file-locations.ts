/**
 * Backfill file_locations for B2-hosted ModelFile rows.
 * =============================================================================
 *
 * Hidden admin route. Guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * Purpose: after `fca184298` routed training-data uploads to Backblaze B2 via
 * feature flag, the `modelFile.upsert` client payload omitted `s3Path`, so
 * `createFileHandler` silently skipped `registerFileLocation`. Result: B2
 * training-data files had no row in storage-resolver `file_locations`, and
 * downloads 404'd at both the resolver AND the delivery-worker fallback (the
 * worker isn't configured for the `civitai-modelfiles` bucket).
 *
 * The client + update-handler fixes stop the leak for new uploads; this
 * endpoint repairs existing rows by re-registering them with the resolver.
 *
 * Usage:
 *   POST /api/admin/temp/backfill-b2-file-locations?token=$WEBHOOK_TOKEN
 *
 * Params (query):
 *   dryRun      - default true. When true, report candidates without calling /register.
 *   batchSize   - default 100. ModelFile rows per DB page.
 *   concurrency - default 3. Parallel /register calls. Keep low; the resolver
 *                 and B2 have their own rate limits and we don't want to stampede.
 *   start       - default 0. Minimum ModelFile.id to consider (resume after abort).
 *   end         - optional. Maximum ModelFile.id to consider.
 *   fileType    - default 'Training Data'. Restrict to one ModelFile.type.
 *                 Pass 'all' to attempt every B2-hosted file.
 */

import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';
import { registerFileLocation } from '~/utils/storage-resolver';
import { isB2Url, parseKey } from '~/utils/s3-utils';

const log = createLogger('backfill-b2-file-locations', 'cyan');

const querySchema = z.object({
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(1000).default(100),
  concurrency: z.coerce.number().min(1).max(10).default(3),
  start: z.coerce.number().optional().default(0),
  end: z.coerce.number().optional(),
  fileType: z.string().default('Training Data'),
});

type Stats = {
  scanned: number;
  registered: number;
  skippedNonB2: number;
  skippedNoKey: number;
  failed: number;
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
    registered: 0,
    skippedNonB2: 0,
    skippedNoKey: 0,
    failed: 0,
  };

  try {
    log(
      `Starting${params.dryRun ? ' (DRY RUN)' : ''} | batchSize=${params.batchSize} ` +
        `concurrency=${params.concurrency} start=${params.start} end=${params.end ?? 'MAX'} ` +
        `fileType=${params.fileType}`
    );

    let cursor = params.start;
    const endCap = params.end;

    // Paginate by ModelFile.id ascending. Each page pulls `batchSize` rows that
    // look B2-hosted, then fans out to the resolver under `concurrency` limit.
    while (true) {
      const files = await dbRead.modelFile.findMany({
        where: {
          id: { gte: cursor, ...(endCap !== undefined && { lte: endCap }) },
          url: { contains: 'backblazeb2.com' },
          ...(params.fileType !== 'all' && { type: params.fileType }),
        },
        select: {
          id: true,
          url: true,
          sizeKB: true,
          modelVersionId: true,
          modelVersion: { select: { modelId: true } },
        },
        orderBy: { id: 'asc' },
        take: params.batchSize,
      });

      if (files.length === 0) break;

      stats.scanned += files.length;
      const firstId = files[0].id;
      const lastId = files[files.length - 1].id;

      const tasks = files.map((file) => async () => {
        // Guard against rows whose URL matched the substring but don't parse
        // as B2 under the current `S3_UPLOAD_B2_ENDPOINT` config. Skip rather
        // than register with the wrong backend.
        if (!isB2Url(file.url)) {
          stats.skippedNonB2++;
          return;
        }

        const { key, bucket } = parseKey(file.url);
        if (!key || !bucket) {
          stats.skippedNoKey++;
          return;
        }

        if (params.dryRun) {
          stats.registered++;
          return;
        }

        try {
          await registerFileLocation({
            fileId: file.id,
            modelVersionId: file.modelVersionId,
            modelId: file.modelVersion.modelId,
            backend: 'backblaze',
            path: key,
            sizeKb: file.sizeKB ?? 0,
          });
          stats.registered++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`  ⚠️  register failed for fileId=${file.id}: ${msg}`);
          stats.failed++;
        }
      });

      await limitConcurrency(tasks, params.concurrency);

      const elapsedSec = (Date.now() - startTime) / 1000;
      const rate = stats.scanned / Math.max(elapsedSec, 0.001);
      log(
        `[batch ${firstId}-${lastId}] ${files.length} scanned | ` +
          `totals: ${stats.scanned} seen, ${stats.registered} registered, ` +
          `${stats.skippedNonB2 + stats.skippedNoKey} skipped, ${stats.failed} failed | ` +
          `${rate.toFixed(1)}/s | elapsed: ${elapsedSec.toFixed(1)}s`
      );

      cursor = lastId + 1;
      if (endCap !== undefined && cursor > endCap) break;
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Completed in ${duration}s`);

    res.status(200).json({
      ok: true,
      dryRun: params.dryRun,
      duration: `${duration}s`,
      lastCursor: cursor,
      result: stats,
    });
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Failed after ${duration}s:`, error);
    res.status(500).json({
      ok: false,
      error: (error as Error).message,
      stats,
    });
  }
});
