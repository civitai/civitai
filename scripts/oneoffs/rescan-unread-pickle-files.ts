/**
 * Re-submits to the orchestrator scan every loadable model file whose stored pickle verdict is
 * Success although the scan read nothing: the legacy scanner's summary says it read no files, or the
 * orchestrator's step skipped an unrecognised format or could not parse it. The scans are marked
 * scan-only: a result (applyScanOnlyOutcome) writes only the verdicts and scannedAt, and refreshes
 * the version's caches and search entry when a verdict changes. It unpublishes nothing and runs no
 * hash checks.
 * A written result replaces `rawScanResult`, so the file leaves the selection; one that came back
 * Pending, failed, or is still in flight stays in it for the next run.
 *
 * Usage:
 *   pnpm run tsscript scripts/oneoffs/rescan-unread-pickle-files.ts            # dry run
 *   pnpm run tsscript scripts/oneoffs/rescan-unread-pickle-files.ts --execute --target=production [--limit=500]
 *
 * Options:
 *   --execute       Submit scans. Without it nothing is written or sent.
 *   --target=T      Required with --execute: production or non-production, and it must match the
 *                   DATABASE_ENVIRONMENT this run is configured for.
 *   --limit=N       Submit at most N files this run (default: all selected).
 *   --concurrency=N Parallel submissions (default 5).
 *   --rate=N        Submit at most N files a minute (default 2).
 *   --file-ids=a,b     Only these files (still subject to the selection).
 *   --version-ids=a,b  Only these versions' files of the rescanned types (still subject to the
 *                      selection). Not with --file-ids. The dry run lists versions with no such file.
 */
import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { env } from '~/env/server';
import { resolveDatabaseEnvironment } from '~/env/database-target';
import {
  createModelFileScanRequest,
  ModelFileScanSubmissionError,
} from '~/server/services/orchestrator/orchestrator.service';
import { SCAN_ONLY_RESCAN_OP } from '~/server/services/orchestrator/model-scan-ops';
import { PICKLE_LOADED_FILE_TYPES } from '~/server/services/model-file-scan.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { expandVersions, idFilter } from './rescan-unread-pickle-files.lib';
import type { ModelType } from '~/shared/utils/prisma/enums';

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const execute = args.includes('--execute');
function positive(name: string, fallback: number) {
  const value = Number(flag(name) ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
  return value;
}
const limit = flag('limit') ? positive('limit', 0) : Infinity;
const concurrency = positive('concurrency', 5);
const perMinute = positive('rate', 2);

// One schedule shared by every worker, so starts are spaced 60s/rate apart whatever the concurrency.
let nextStart = 0;
function awaitStartSlot(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextStart - now);
  nextStart = Math.max(now, nextStart) + 60_000 / perMinute;
  return new Promise<void>((resolve) => setTimeout(resolve, wait));
}
const ids = idFilter(flag('file-ids'), flag('version-ids'));
let fileIds = ids.fileIds;

// A submission inside this window is still in flight; submitting again would only double the work.
const IN_FLIGHT_MS = 24 * 60 * 60 * 1000;
const PAGE = 1000;
// Safetensors and GGUF honestly read no pickle; 'null' is a file with no recorded format.
const PICKLE_CAPABLE_FORMATS = ['PickleTensor', 'pt', 'Diffusers', 'Other', 'null'];

type Row = {
  id: number;
  type: string;
  url: string;
  sizeKB: number;
  modelVersionId: number;
  baseModel: string;
  modelId: number;
  modelType: ModelType;
};

function selectPage(afterId: number) {
  const inFlightSince = new Date(Date.now() - IN_FLIGHT_MS);
  return dbRead.$queryRaw<Row[]>`
    SELECT mf.id, mf.type, mf.url, mf."sizeKB", mv.id AS "modelVersionId", mv."baseModel",
      m.id AS "modelId", m.type AS "modelType"
    FROM "ModelFile" mf
    JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE mf.id > ${afterId}
      AND mf.type IN (${Prisma.join(PICKLE_LOADED_FILE_TYPES)})
      AND mf."pickleScanResult" = 'Success'
      AND (
        (mf."rawScanResult"->>'picklescanOutput' LIKE '%Scanned files: 0%'
          AND coalesce(mf.metadata->>'format', 'null') IN (${Prisma.join(PICKLE_CAPABLE_FORMATS)}))
        OR (mf."rawScanResult"->'steps'->1->>'$type' = 'modelPickleScan'
          AND (mf."rawScanResult"->'steps'->1->'output'->>'status' = 'parseError'
            OR (mf."rawScanResult"->'steps'->1->'output'->>'status' LIKE 'skipped%'
              AND mf."rawScanResult"->'steps'->1->'output'->>'status' NOT IN ('skippedSafetensors', 'skippedGguf'))
            OR (mf."rawScanResult"->'steps'->1->'output'->>'status' = 'clean'
              AND lower(mf.name) NOT LIKE '%.zip'
              AND coalesce(mf."rawScanResult"->'steps'->1->'output'->>'scannedFileCount', '0') = '0'
              AND coalesce(mf."rawScanResult"->'steps'->1->'output'->>'output', '') NOT SIMILAR TO '%Scanned files: [1-9]%')))
      )
      AND mf.exists IS NOT FALSE
      AND (mf."scanRequestedAt" IS NULL OR mf."scanRequestedAt" < ${inFlightSince})
      ${fileIds?.length ? Prisma.sql`AND mf.id IN (${Prisma.join(fileIds)})` : Prisma.empty}
    ORDER BY mf.id
    LIMIT ${PAGE}`;
}

/** Every reason this run must not submit: results would be faked, or land in another environment. */
function executeRefusals() {
  const refusals: string[] = [];
  const target = flag('target');
  const database = resolveDatabaseEnvironment();
  // Outside production without a token, the scan request writes a fake Success instead of scanning.
  if (!env.ORCHESTRATOR_ACCESS_TOKEN) refusals.push('ORCHESTRATOR_ACCESS_TOKEN is not set');
  if (target !== 'production' && target !== 'non-production')
    refusals.push('--target must be production or non-production');
  if (target !== database) refusals.push(`--target=${target} but the database is ${database}`);
  const callback = new URL(env.NEXTAUTH_URL);
  const localCallback =
    ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(callback.hostname) ||
    callback.protocol !== 'https:';
  if (target === 'production' && localCallback)
    refusals.push(`results would be delivered to ${callback.origin}, not the production site`);
  return refusals;
}

async function main() {
  if (execute) {
    const refusals = executeRefusals();
    if (refusals.length) throw new Error(`Refusing to submit:\n- ${refusals.join('\n- ')}`);
  }

  let versionReport: Record<string, unknown> | undefined;
  if (ids.versionIds) {
    const files = await dbRead.modelFile.findMany({
      where: {
        modelVersionId: { in: ids.versionIds },
        type: { in: PICKLE_LOADED_FILE_TYPES },
      },
      select: { id: true, modelVersionId: true },
    });
    const expanded = expandVersions(ids.versionIds, files);
    fileIds = expanded.fileIds;
    versionReport = {
      versions: ids.versionIds.length,
      files: expanded.fileIds.length,
      versionsWithoutFiles: expanded.versionsWithoutFiles,
    };
    if (!fileIds.length) fileIds = [-1];
  }

  const byType = new Map<string, { files: number; kb: number }>();
  const submitted: number[] = [];
  const failed: { id: number; reason: string }[] = [];
  let afterId = 0;
  let selected = 0;

  while (selected < limit) {
    const page = await selectPage(afterId);
    if (!page.length) break;
    afterId = page[page.length - 1].id;
    const batch = page.slice(0, Math.max(0, limit - selected));
    selected += batch.length;

    for (const row of batch) {
      const t = byType.get(row.type) ?? { files: 0, kb: 0 };
      byType.set(row.type, { files: t.files + 1, kb: t.kb + row.sizeKB });
    }
    if (!execute) continue;

    await limitConcurrency(
      batch.map((row) => async () => {
        try {
          await createModelFileScanRequest({
            fileId: row.id,
            modelVersionId: row.modelVersionId,
            modelId: row.modelId,
            modelType: row.modelType,
            baseModel: row.baseModel,
            url: row.url,
            priority: 'normal',
            op: SCAN_ONLY_RESCAN_OP,
          });
          submitted.push(row.id);
        } catch (e) {
          const reason =
            e instanceof ModelFileScanSubmissionError ? e.code : (e as Error).message ?? String(e);
          failed.push({ id: row.id, reason });
        }
      }),
      {
        limit: concurrency,
        betweenTasksFn: awaitStartSlot,
      }
    );
    console.log(
      `submitted through file ${afterId}: ${submitted.length} ok, ${failed.length} failed`
    );
  }

  const totalKB = [...byType.values()].reduce((sum, t) => sum + t.kb, 0);
  console.log(
    JSON.stringify(
      {
        mode: execute ? 'execute' : 'dry-run',
        ...(versionReport && { versionIds: versionReport }),
        selected,
        totalBytes: Math.round(totalKB * 1024),
        byType: Object.fromEntries(byType),
        ...(execute && { submitted: submitted.length, failed }),
      },
      null,
      2
    )
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
