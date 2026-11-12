/**
 * One-off: sweep .com faces through the listing check. Every model that still has a .com cover is
 * checked the way a listing edit re-checks it, and those it flags leave .com the same way.
 *
 * Usage (repo root, with the app's env):
 *   pnpm run tsscript scripts/oneoffs/sweep-com-faces.ts [--out <file>] [--concurrency 4] [--delay-ms 250]
 *     Dry run. Writes nothing to the database. Writes the run file to --out (default: a new file in
 *     the OS temp dir) and prints counts, up to 10 sample ids, the file's path and its sha256.
 *   pnpm run tsscript scripts/oneoffs/sweep-com-faces.ts --apply --ids-file <file> --sha256 <hex> --expect <n> [--log <file>]
 *     Takes off exactly the models the dry run flagged, without checking again; refused unless the
 *     file has the sha256 the dry run printed and lists exactly n. A model whose .com cover or
 *     listing changed since the dry run is left alone. Writes the run log (the input to
 *     restore-com-faces.ts) as it goes, and one batch-level ModActivity row at the end.
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
export type Listing = { name: string; description: string | null; triggerWords: string[] };
export type Detected = {
  id: number;
  sfwCoverImageId: number;
  /** The listing the verdict was on; apply leaves a model whose listing changed since. */
  listingHash: string;
  reason?: string;
};
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
  /** The cover or the listing changed since the dry run. */
  skipped: number[];
  /** Threw part-way: the cover may or may not be off. restore-com-faces.ts takes these too. */
  failed: { id: number; sfwCoverImageId: number }[];
};

export type Deps = {
  faces: (after: number, take: number) => Promise<Face[]>;
  listing: (face: Face) => Promise<Listing>;
  check: (listing: Listing) => Promise<ComFaceIntentVerdict>;
  /** The model's listing now, read from the primary; null when it is gone. */
  currentListing: (modelId: number) => Promise<Listing | null>;
  remove: (model: Detected) => Promise<boolean>;
  /** Writes the run log; called before the first removal and after every batch. */
  save: (log: RunLog) => void;
  logRun: (row: { activity: string; entityType: string; entityId: number }) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};
type Pace = { concurrency: number; delayMs: number };

/** The batch-level ModActivity row's entityType: names the run and the dry-run file it acted on. */
export const runEntityType = (runId: string, runFileSha256: string) =>
  `comFaceSweep:${runId}:${runFileSha256.slice(0, 16)}`;

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export const listingHash = ({ name, description, triggerWords }: Listing) =>
  sha256(JSON.stringify([name, description ?? '', [...triggerWords].sort()]));

/** Parses a private run file without letting its text reach an error message. */
export function parseRunFile<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('the file is not valid JSON');
  }
}

export function readPace(raw: { concurrency?: string; delayMs?: string }): Pace {
  const concurrency = Number(raw.concurrency ?? 4);
  const delayMs = Number(raw.delayMs ?? 250);
  if (!Number.isInteger(concurrency) || concurrency < 1 || !(delayMs >= 0))
    throw new Error('--concurrency must be a whole number from 1, --delay-ms 0 or more');
  return { concurrency, delayMs };
}

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
      const read = await deps
        .listing(face)
        .then(async (listing) => ({ listing, verdict: await deps.check(listing) }))
        .catch(() => ({ listing: null, verdict: { status: 'unavailable' as const } }));
      const { verdict } = read;
      counts.faces++;
      counts[verdict.status]++;
      if (verdict.status === 'detected')
        file.detected.push({
          id: face.id,
          sfwCoverImageId: face.sfwCoverImageId,
          listingHash: listingHash(read.listing as Listing),
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
  {
    expect,
    fileSha256,
    runId,
    ...pace
  }: Pace & { expect: number; fileSha256: string; runId: string }
): Promise<RunLog> {
  if (sha256(fileText) !== fileSha256)
    throw new Error('the file is not the one whose sha256 was given; nothing written');
  const file = parseRunFile<RunFile>(fileText);
  if (file.kind !== 'com-face-sweep-dry-run')
    throw new Error('not a dry-run file from this script');
  if (file.detected.length !== expect)
    throw new Error(
      `the file lists ${file.detected.length}, not --expect ${expect}; nothing written`
    );

  const log: RunLog = {
    kind: 'com-face-sweep-apply',
    runId,
    runFileSha256: sha256(fileText),
    startedAt: new Date().toISOString(),
    finishedAt: '',
    removed: [],
    skipped: [],
    failed: [],
  };
  deps.save(log);
  await paced(file.detected, pace, deps, async (model) => {
    try {
      const now = await deps.currentListing(model.id);
      if (!now || listingHash(now) !== model.listingHash) log.skipped.push(model.id);
      else if (await deps.remove(model))
        log.removed.push({ id: model.id, sfwCoverImageId: model.sfwCoverImageId });
      else log.skipped.push(model.id);
    } catch {
      log.failed.push({ id: model.id, sfwCoverImageId: model.sfwCoverImageId });
    }
    deps.save(log);
  });
  log.finishedAt = new Date().toISOString();
  deps.save(log);
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
  const { finishRemoval, queueComFaceRecheck, removeComFace } = await import(
    '~/server/services/model-com-face-recheck.service'
  );
  const { checkComFaceIntentVerdict, getOwnTriggerWords } = await import(
    '~/server/services/model-sfw-face.service'
  );
  const apply_ = process.argv.includes('--apply');
  const runId = randomUUID();
  const logPath = arg('--log') ?? path.join(os.tmpdir(), `${SCRIPT_BASENAME}-apply-${runId}.json`);
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
    listing: async (face) => ({
      name: face.name,
      description: face.description,
      triggerWords: await getOwnTriggerWords({ modelId: face.id, userId: face.userId }),
    }),
    check: (listing) => checkComFaceIntentVerdict(listing),
    currentListing: async (modelId) => {
      const model = await dbWrite.model.findUnique({
        where: { id: modelId },
        select: { userId: true, name: true, description: true },
      });
      if (!model) return null;
      const triggerWords = await getOwnTriggerWords({ modelId, userId: model.userId, db: dbWrite });
      return { name: model.name, description: model.description, triggerWords };
    },
    remove: async (model) => {
      try {
        return await removeComFace(model.id, model.sfwCoverImageId, 'detected', model.reason);
      } catch (error) {
        // The cover may be off with the level not yet recomputed, which leaves the model on .com.
        // Recomputing is idempotent and harmless when the write never landed; the queued re-check
        // finishes it again if this try fails too.
        await finishRemoval(model.id).catch(() => undefined);
        await queueComFaceRecheck(model.id);
        throw error;
      }
    },
    save: (log) => writeFileSync(logPath, JSON.stringify(log), { mode: 0o600 }),
    logRun: async (data) => {
      await dbWrite.modActivity.create({ data });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const pace = readPace({ concurrency: arg('--concurrency'), delayMs: arg('--delay-ms') });

  if (!apply_) {
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
  const fileSha256 = arg('--sha256');
  const expect = Number(arg('--expect'));
  if (!idsFile || !fileSha256 || !Number.isInteger(expect))
    throw new Error('--apply needs --ids-file, --sha256 and --expect');
  const log = await apply(deps, readFileSync(idsFile, 'utf8'), {
    expect,
    fileSha256,
    runId,
    ...pace,
  });
  console.log({
    mode: 'apply',
    runId,
    removed: log.removed.length,
    skipped: log.skipped.length,
    failed: log.failed.length,
    log: logPath,
  });
}

if (path.basename(process.argv[1] ?? '').startsWith(`${SCRIPT_BASENAME}.`))
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
