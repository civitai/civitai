/**
 * One-off: undoes a sweep-com-faces.ts run. Puts back the .com cover the run took off, only while
 * nothing has moved since: the cover is still empty, the removal marker is the one that run wrote
 * (reason `detected`, the same cover, stamped inside the run), and the image still exists. The
 * listing check must pass on today's listing first (dry run included, so it calls the check). The
 * level is then recomputed, which re-checks that the cover is still a valid .com cover, and the
 * listing re-check is queued for an edit made in between.
 *
 * Usage (repo root, with the app's env):
 *   pnpm run tsscript scripts/oneoffs/restore-com-faces.ts --log <apply run log> [--ids 1,2,3]
 *     Dry run: counts what would be restored. --ids limits it to those models of the run.
 *   ... --apply [--out <file>]
 *     Restores, writes the undo log (ids and count) and one batch-level ModActivity row.
 *
 * The run log and the undo log hold model ids: both stay private.
 */
import { Prisma } from '@prisma/client';
import { readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { parseRunFile, runEntityType, type RunLog } from './sweep-com-faces';

export const SCRIPT_BASENAME = 'restore-com-faces';

type Target = { id: number; sfwCoverImageId: number };
type Sql = (query: Prisma.Sql) => Promise<number>;

/** Restores one model's cover, or matches it on a dry run. Returns the rows it touched (0 or 1). */
export const restoreSql = (log: RunLog, target: Target, write: boolean) => {
  const guard = Prisma.sql`
    WHERE id = ${target.id}
      AND "sfwCoverImageId" IS NULL
      AND jsonb_typeof(meta) = 'object'
      AND meta -> 'comFaceRemoved' ->> 'reason' = 'detected'
      AND (meta -> 'comFaceRemoved' ->> 'sfwCoverImageId')::int = ${target.sfwCoverImageId}
      AND (meta -> 'comFaceRemoved' ->> 'at')::timestamptz
        BETWEEN ${log.startedAt}::timestamptz
          -- A run that crashed never wrote its end.
          AND ${log.finishedAt || new Date().toISOString()}::timestamptz
      AND EXISTS (SELECT 1 FROM "Image" WHERE id = ${target.sfwCoverImageId})`;
  return write
    ? Prisma.sql`UPDATE "Model"
        SET "sfwCoverImageId" = ${target.sfwCoverImageId}, meta = meta - 'comFaceRemoved'
        ${guard}`
    : Prisma.sql`SELECT 1 FROM "Model" ${guard}`;
};

export type Deps = {
  /** $executeRaw for the write; for the dry run, a query that returns the matched row count. */
  run: Sql;
  finish: (modelId: number) => Promise<void>;
  /** The listing check on the model's listing today; only `allowed` is restored. */
  allowed: (modelId: number) => Promise<boolean>;
  /** Queues the listing re-check, which takes the face off again if today's listing fails. Never
   *  throws. */
  recheck: (modelId: number) => Promise<void>;
  logRun: (row: { activity: string; entityType: string; entityId: number }) => Promise<void>;
};

export async function restore(
  deps: Deps,
  logText: string,
  { ids, write }: { ids?: number[]; write: boolean }
) {
  const log = parseRunFile<RunLog>(logText);
  if (log.kind !== 'com-face-sweep-apply') throw new Error('not a run log from sweep-com-faces.ts');
  let targets = [...log.removed, ...log.pending, ...log.failed];
  if (ids) {
    const unknown = ids.filter((id) => !targets.some((t) => t.id === id));
    if (unknown.length) throw new Error(`${unknown.length} --ids are not in this run`);
    targets = targets.filter((t) => ids.includes(t.id));
  }
  const restored: number[] = [];
  const skipped: number[] = [];
  /** Today's listing does not pass the check (or got no verdict): left off .com. */
  const keptByCheck: number[] = [];
  /** The restore or its level recompute threw; the cover may be back while the model stays off .com. */
  const failed: number[] = [];
  for (const target of targets) {
    if (!(await deps.allowed(target.id).catch(() => false))) {
      keptByCheck.push(target.id);
      continue;
    }
    let touched: number;
    try {
      touched = await deps.run(restoreSql(log, target, write));
    } catch {
      failed.push(target.id);
      continue;
    }
    if (!touched) {
      skipped.push(target.id);
      continue;
    }
    if (!write) {
      restored.push(target.id);
      continue;
    }
    // An edit between the check and the write gets its own re-check.
    await deps.recheck(target.id);
    // Once more on failure: a rerun skips this model (its cover is back), so nothing else would.
    try {
      await deps.finish(target.id).catch(() => deps.finish(target.id));
      restored.push(target.id);
    } catch {
      failed.push(target.id);
    }
  }
  if (write)
    await deps.logRun({
      activity: 'comFaceSweepUndo',
      entityType: runEntityType(log.runId, log.runFileSha256),
      entityId: restored.length,
    });
  return { runId: log.runId, restored, skipped, keptByCheck, failed };
}

function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const logPath = arg('--log');
  if (!logPath) throw new Error('--log <apply run log> is required');
  const write = process.argv.includes('--apply');
  const ids = arg('--ids')?.split(',').map(Number);
  if (ids?.some((id) => !Number.isInteger(id)))
    throw new Error('--ids takes model ids, comma-separated');
  const { dbWrite } = await import('~/server/db/client');
  const { finishRemoval, queueComFaceRecheck } = await import(
    '~/server/services/model-com-face-recheck.service'
  );
  const { checkComFaceIntentVerdict, getOwnTriggerWords } = await import(
    '~/server/services/model-sfw-face.service'
  );
  const deps: Deps = {
    run: async (query) =>
      write ? dbWrite.$executeRaw(query) : (await dbWrite.$queryRaw<unknown[]>(query)).length,
    finish: finishRemoval,
    recheck: queueComFaceRecheck,
    allowed: async (modelId) => {
      const model = await dbWrite.model.findUnique({
        where: { id: modelId },
        select: { userId: true, name: true, description: true },
      });
      if (!model) return false;
      const triggerWords = await getOwnTriggerWords({ modelId, userId: model.userId, db: dbWrite });
      const verdict = await checkComFaceIntentVerdict({ ...model, triggerWords });
      return verdict.status === 'allowed';
    },
    logRun: async (data) => {
      await dbWrite.modActivity.create({ data });
    },
  };
  const result = await restore(deps, readFileSync(logPath, 'utf8'), { ids, write });
  if (write) {
    const out = arg('--out') ?? path.join(os.tmpdir(), `${SCRIPT_BASENAME}-${Date.now()}.json`);
    writeFileSync(out, JSON.stringify({ ...result, count: result.restored.length }), {
      mode: 0o600,
    });
    console.log({
      mode: 'apply',
      restored: result.restored.length,
      skipped: result.skipped.length,
      keptByCheck: result.keptByCheck.length,
      failed: result.failed.length,
      log: out,
    });
  } else {
    console.log({
      mode: 'dry run',
      wouldRestore: result.restored.length,
      skipped: result.skipped.length,
      keptByCheck: result.keptByCheck.length,
    });
  }
}

if (path.basename(process.argv[1] ?? '').startsWith(`${SCRIPT_BASENAME}.`))
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
