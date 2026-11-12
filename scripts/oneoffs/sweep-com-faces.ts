/**
 * One-off: sweep .com faces through the listing check. Every model that still has a .com cover is
 * checked the way a listing edit re-checks it, and those it flags leave .com the same way.
 *
 * Usage (repo root, with the app's env):
 *   pnpm run tsscript scripts/oneoffs/sweep-com-faces.ts [--out <file>] [--concurrency 4] [--delay-ms 250]
 *     Dry run. Writes nothing to the database. Writes the run file to --out (default: a new file in
 *     the OS temp dir) and prints counts, up to 10 sample ids, the file's path and its sha256.
 *   pnpm run tsscript scripts/oneoffs/sweep-com-faces.ts --apply --ids-file <file> --expect <n> [--log <file>]
 *     Takes off exactly the models the dry run flagged, without checking again; refused unless the
 *     file lists exactly n. A model whose .com cover changed since the dry run is left alone. Writes
 *     the run log (the input to restore-com-faces.ts) and one batch-level ModActivity row.
 *
 * The run file holds the check's reasons and the run log holds model ids: both stay private. Never
 * commit or paste either.
 */
import { createHash, randomUUID } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { ComFaceIntentVerdict } from '~/server/services/model-sfw-face.service';

export const SCRIPT_BASENAME = 'sweep-com-faces';
const BATCH = 500;
const SAMPLE = 10;

export type Face = {
  id: number;
  userId: number;
  name: string;
  description: string | null;
  sfwCoverImageId: number;
};
export type Detected = { id: number; sfwCoverImageId: number; reason?: string };
export type RunFile = {
  kind: 'com-face-sweep-dry-run';
  createdAt: string;
  detected: Detected[];
  unavailable: number[];
};
export type RunLog = {
  kind: 'com-face-sweep-apply';
  runId: string;
  runFileSha256: string;
  startedAt: string;
  finishedAt: string;
  removed: { id: number; sfwCoverImageId: number }[];
  skipped: number[];
  /** Threw part-way: the cover may or may not be off. restore-com-faces.ts takes these too. */
  failed: { id: number; sfwCoverImageId: number }[];
};

export type Deps = {
  faces: (after: number, take: number) => Promise<Face[]>;
  check: (face: Face) => Promise<ComFaceIntentVerdict>;
  remove: (model: Detected) => Promise<boolean>;
  logRun: (row: { activity: string; entityType: string; entityId: number }) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};
type Pace = { concurrency: number; delayMs: number };

/** The batch-level ModActivity row's entityType: names the run and the dry-run file it acted on. */
export const runEntityType = (runId: string, runFileSha256: string) =>
  `comFaceSweep:${runId}:${runFileSha256.slice(0, 16)}`;

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function paced<T>(
  items: T[],
  { concurrency, delayMs }: Pace,
  deps: Deps,
  fn: (item: T) => Promise<void>
) {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(fn));
    if (delayMs) await deps.sleep(delayMs);
  }
}

/** Dry run: checks every face, writes nothing. */
export async function scan(deps: Deps, pace: Pace) {
  const counts = { faces: 0, allowed: 0, detected: 0, unavailable: 0 };
  const file: RunFile = {
    kind: 'com-face-sweep-dry-run',
    createdAt: new Date().toISOString(),
    detected: [],
    unavailable: [],
  };
  for (let after = 0; ; ) {
    const faces = await deps.faces(after, BATCH);
    if (!faces.length) break;
    after = faces[faces.length - 1].id;
    await paced(faces, pace, deps, async (face) => {
      // No verdict is never a removal: a later run can pick these up.
      const verdict = await deps.check(face).catch(() => ({ status: 'unavailable' as const }));
      counts.faces++;
      counts[verdict.status]++;
      if (verdict.status === 'detected')
        file.detected.push({
          id: face.id,
          sfwCoverImageId: face.sfwCoverImageId,
          reason: verdict.reason,
        });
      else if (verdict.status === 'unavailable') file.unavailable.push(face.id);
    });
  }
  file.detected.sort((a, b) => a.id - b.id);
  file.unavailable.sort((a, b) => a - b);
  return { counts, file };
}

/** Prod run: removes exactly the run file's detected models. */
export async function apply(
  deps: Deps,
  fileText: string,
  { expect, ...pace }: Pace & { expect: number }
): Promise<RunLog> {
  const file = JSON.parse(fileText) as RunFile;
  if (file.kind !== 'com-face-sweep-dry-run')
    throw new Error('not a dry-run file from this script');
  if (file.detected.length !== expect)
    throw new Error(
      `the file lists ${file.detected.length}, not --expect ${expect}; nothing written`
    );

  const log: RunLog = {
    kind: 'com-face-sweep-apply',
    runId: randomUUID(),
    runFileSha256: sha256(fileText),
    startedAt: new Date().toISOString(),
    finishedAt: '',
    removed: [],
    skipped: [],
    failed: [],
  };
  await paced(file.detected, pace, deps, async (model) => {
    try {
      if (await deps.remove(model))
        log.removed.push({ id: model.id, sfwCoverImageId: model.sfwCoverImageId });
      else log.skipped.push(model.id);
    } catch {
      log.failed.push({ id: model.id, sfwCoverImageId: model.sfwCoverImageId });
    }
  });
  log.finishedAt = new Date().toISOString();
  await deps.logRun({
    activity: 'comFaceSweep',
    entityType: runEntityType(log.runId, log.runFileSha256),
    entityId: log.removed.length,
  });
  return log;
}

function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const { dbRead, dbWrite } = await import('~/server/db/client');
  const { finishRemoval, removeComFace } = await import(
    '~/server/services/model-com-face-recheck.service'
  );
  const { checkComFaceIntentVerdict, getOwnTriggerWords } = await import(
    '~/server/services/model-sfw-face.service'
  );
  const deps: Deps = {
    faces: (after, take) =>
      dbRead.model.findMany({
        // As the edit re-check reads a model: a .com face needs its .com title too.
        where: {
          id: { gt: after },
          sfwCoverImageId: { not: null },
          sfwName: { not: null },
          deletedAt: null,
        },
        select: { id: true, userId: true, name: true, description: true, sfwCoverImageId: true },
        orderBy: { id: 'asc' },
        take,
      }) as Promise<Face[]>,
    check: async (face) =>
      checkComFaceIntentVerdict({
        name: face.name,
        description: face.description,
        triggerWords: await getOwnTriggerWords({ modelId: face.id, userId: face.userId }),
      }),
    remove: async (model) => {
      try {
        return await removeComFace(model.id, model.sfwCoverImageId, 'detected', model.reason);
      } catch (error) {
        // The cover may be off with the level not yet recomputed, which leaves the model on .com.
        // Recomputing is idempotent and harmless when the write never landed.
        await finishRemoval(model.id).catch(() => undefined);
        throw error;
      }
    },
    logRun: async (data) => {
      await dbWrite.modActivity.create({ data });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const pace = {
    concurrency: Number(arg('--concurrency') ?? 4),
    delayMs: Number(arg('--delay-ms') ?? 250),
  };

  if (!process.argv.includes('--apply')) {
    const { counts, file } = await scan(deps, pace);
    const out = arg('--out') ?? path.join(os.tmpdir(), `${SCRIPT_BASENAME}-${Date.now()}.json`);
    const text = JSON.stringify(file);
    writeFileSync(out, text, { mode: 0o600 });
    console.log({
      mode: 'dry run',
      ...counts,
      sampleDetectedIds: file.detected.slice(0, SAMPLE).map((d) => d.id),
      file: out,
      sha256: sha256(text),
    });
    return;
  }

  const idsFile = arg('--ids-file');
  const expect = Number(arg('--expect'));
  if (!idsFile || !Number.isInteger(expect))
    throw new Error('--apply needs --ids-file and --expect');
  const log = await apply(deps, readFileSync(idsFile, 'utf8'), { expect, ...pace });
  const out = arg('--log') ?? path.join(os.tmpdir(), `${SCRIPT_BASENAME}-apply-${log.runId}.json`);
  writeFileSync(out, JSON.stringify(log), { mode: 0o600 });
  console.log({
    mode: 'apply',
    runId: log.runId,
    removed: log.removed.length,
    skipped: log.skipped.length,
    failed: log.failed.length,
    log: out,
  });
}

if (process.argv[1]?.includes(SCRIPT_BASENAME))
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
