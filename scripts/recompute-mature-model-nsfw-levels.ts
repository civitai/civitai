import { readFileSync } from 'fs';
import { parseArgs } from 'util';
import { Prisma } from '@prisma/client';

import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { bustMvCache } from '~/server/services/model-version.service';
import {
  updateModelNsfwLevels,
  updateModelVersionNsfwLevels,
} from '~/server/services/nsfwLevels.service';
import {
  nsfwBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { runScriptAndExit } from './lib/run-as-script';

/**
 * Recompute the stored nsfwLevel of mature models (`Model.nsfw = true`) and every version under
 * them, through the same rollups the JobQueue runs: versions first (`updateModelVersionNsfwLevels`),
 * then models (`updateModelNsfwLevels`). A model recompute alone leaves the versions' safe bits in
 * place, and the version-level API filters on those.
 *
 *   pnpm run tsscript scripts/recompute-mature-model-nsfw-levels.ts --ids-file <csv> [--apply]
 *     [--chunk 250] [--from <model id>]
 *   pnpm run tsscript scripts/recompute-mature-model-nsfw-levels.ts --ids-file <csv> --readback
 *
 * `--ids-file` is a CSV whose first column is the model id (a header row is skipped). Keep it
 * outside the repo.
 *
 * Modes:
 *   (default)   Dry run. Read-only on the replica: the scope check, the current counts and the
 *               counts the rollups will produce. Writes nothing.
 *   --apply     Runs the scope check on the primary, then, per chunk of models in id order, the
 *               version rollup, the model rollup and the cache busts, pausing a second between
 *               chunks and stopping at the first error. Then reads the counts for the whole set
 *               back from the primary, and exits 1 if any row still carries a safe bit.
 *               `--from <id>` resumes at that model id (the last line printed names the next one).
 *   --readback  Read-only on the replica: the same counts as the dry run's "now", for checking
 *               after replication catches up. Exits 1 if any row still carries a safe bit.
 *
 * Scope: every id must be a live mature model with no civitai.com version (no sfwName and no
 * sfwCoverImageId) and at least one Published version. For such a model both rollups produce 60
 * (R|X|XXX|Blocked), for the model and every version, so the dry run's prediction is exact. Any id
 * outside the scope stops the run before anything is written, and so does the version rollup's
 * system-model kill switch being off, since it would skip some versions.
 */

const PAUSE_MS = 1000;

/** The ids from `from` on, ascending, in chunks of `size`. */
export function chunksFrom(ids: number[], size: number, from = 0): number[][] {
  const sorted = ids.filter((id) => id >= from).sort((a, b) => a - b);
  const chunks: number[][] = [];
  for (let i = 0; i < sorted.length; i += size) chunks.push(sorted.slice(i, i + size));
  return chunks;
}

type ScopeRow = {
  id: number;
  nsfw: boolean;
  deleted: boolean;
  hasComFace: boolean;
  hasPublishedVersion: boolean;
};

export function parseIdsCsv(text: string): number[] {
  const ids: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const first = line.split(',')[0]?.trim().replace(/^"|"$/g, '');
    if (!first) continue;
    if (!/^\d+$/.test(first)) {
      if (ids.length === 0) continue; // header row
      throw new Error(`Not a model id: "${first}"`);
    }
    ids.push(Number(first));
  }
  return [...new Set(ids)];
}

/** The ids that may not be recomputed by this script, each with why. */
export function outOfScope(ids: number[], rows: ScopeRow[]): { id: number; reason: string }[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const refused: { id: number; reason: string }[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) refused.push({ id, reason: 'not found' });
    else if (row.deleted) refused.push({ id, reason: 'deleted' });
    else if (!row.nsfw) refused.push({ id, reason: 'not mature (nsfw = false)' });
    else if (row.hasComFace) refused.push({ id, reason: 'has a civitai.com version' });
    // updateModelNsfwLevels only updates models with a Published version.
    else if (!row.hasPublishedVersion) refused.push({ id, reason: 'no Published version' });
  }
  return refused;
}

type Db = typeof dbRead;

async function readScope(db: Db, ids: number[]) {
  return db.$queryRaw<ScopeRow[]>(Prisma.sql`
    SELECT m.id, m.nsfw,
           (m."deletedAt" IS NOT NULL OR m.status = 'Deleted') AS deleted,
           (m."sfwName" IS NOT NULL OR m."sfwCoverImageId" IS NOT NULL) AS "hasComFace",
           EXISTS (
             SELECT 1 FROM "ModelVersion" mv WHERE mv."modelId" = m.id AND mv.status = 'Published'
           ) AS "hasPublishedVersion"
    FROM "Model" m
    WHERE m.id IN (${Prisma.join(ids)})
  `);
}

type Counts = {
  models: number;
  modelsWithSafeBit: number;
  modelsAt60: number;
  versions: number;
  publishedVersions: number;
  versionsWithSafeBit: number;
  versionsAt60: number;
};

async function readCounts(db: Db, ids: number[]): Promise<Counts> {
  const [row] = await db.$queryRaw<Record<keyof Counts, bigint>[]>(Prisma.sql`
    WITH m AS (SELECT id, "nsfwLevel" FROM "Model" WHERE id IN (${Prisma.join(ids)})),
         v AS (
           SELECT mv.status, mv."nsfwLevel"
           FROM "ModelVersion" mv JOIN m ON m.id = mv."modelId"
         )
    SELECT
      (SELECT count(*) FROM m) AS models,
      (SELECT count(*) FROM m WHERE ("nsfwLevel" & ${sfwBrowsingLevelsFlag}) != 0) AS "modelsWithSafeBit",
      (SELECT count(*) FROM m WHERE "nsfwLevel" = ${nsfwBrowsingLevelsFlag}) AS "modelsAt60",
      (SELECT count(*) FROM v) AS versions,
      (SELECT count(*) FROM v WHERE status = 'Published') AS "publishedVersions",
      (SELECT count(*) FROM v WHERE ("nsfwLevel" & ${sfwBrowsingLevelsFlag}) != 0) AS "versionsWithSafeBit",
      (SELECT count(*) FROM v WHERE "nsfwLevel" = ${nsfwBrowsingLevelsFlag}) AS "versionsAt60"
  `);
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)])) as Counts;
}

function printCounts(label: string, counts: Counts) {
  console.log(`${label}:`);
  console.log(
    `  models ${counts.models}: with a safe bit ${counts.modelsWithSafeBit}, at 60 ${counts.modelsAt60}`
  );
  console.log(
    `  versions ${counts.versions} (Published ${counts.publishedVersions}): ` +
      `with a safe bit ${counts.versionsWithSafeBit}, at 60 ${counts.versionsAt60}`
  );
}

async function assertInScope(db: Db, ids: number[]) {
  const refused = outOfScope(ids, await readScope(db, ids));
  for (const { id, reason } of refused) console.error(`  out of scope: ${id} (${reason})`);
  if (refused.length)
    throw new Error(`${refused.length} of ${ids.length} ids are out of scope; nothing was written`);

  const raw = await sysRedis.hGet(
    REDIS_SYS_KEYS.SYSTEM.FEATURES,
    'update-system-model-version-nsfw-level'
  );
  const flag = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  if (flag === 'false')
    throw new Error(
      'The version rollup kill switch is off (system-model versions would be skipped); nothing was written'
    );
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'ids-file': { type: 'string' },
      apply: { type: 'boolean', default: false },
      readback: { type: 'boolean', default: false },
      chunk: { type: 'string', default: '250' },
      from: { type: 'string', default: '0' },
    },
  });
  const chunkSize = Number(values.chunk);
  const from = Number(values.from);
  if (!Number.isInteger(chunkSize) || chunkSize <= 0)
    throw new Error('--chunk must be a positive integer');
  if (!Number.isInteger(from) || from < 0) throw new Error('--from must be a model id');
  if (!values['ids-file']) throw new Error('Pass --ids-file <csv>');
  if (values.apply && values.readback) throw new Error('Pass --apply or --readback, not both');
  const ids = parseIdsCsv(readFileSync(values['ids-file'], 'utf8'));
  if (!ids.length) throw new Error('No ids in the file');
  console.log(`ids: ${ids.length}`);

  if (values.readback) {
    const counts = await readCounts(dbRead, ids);
    printCounts('replica readback', counts);
    if (counts.modelsWithSafeBit || counts.versionsWithSafeBit)
      throw new Error('Rows still carry a safe bit');
    return;
  }

  if (!values.apply) {
    await assertInScope(dbRead, ids);
    console.log('scope: every id is in scope');
    const now = await readCounts(dbRead, ids);
    printCounts('now (replica)', now);
    printCounts('after --apply (predicted)', {
      ...now,
      modelsWithSafeBit: 0,
      modelsAt60: now.models,
      versionsWithSafeBit: 0,
      versionsAt60: now.versions,
    });
    console.log('dry run: nothing written');
    return;
  }

  const chunks = chunksFrom(ids, chunkSize, from);
  if (!chunks.length) throw new Error(`No ids at or after ${from}`);
  await assertInScope(dbWrite, chunks.flat());
  printCounts('before (primary)', await readCounts(dbWrite, ids));
  for (const [index, modelIds] of chunks.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    const versions = await dbWrite.modelVersion.findMany({
      where: { modelId: { in: modelIds } },
      select: { id: true },
    });
    const versionIds = versions.map((v) => v.id);
    await updateModelVersionNsfwLevels(versionIds);
    await updateModelNsfwLevels(modelIds);
    // With model ids, this also refreshes dataForModelsCache and queues the search index.
    await bustMvCache(versionIds, modelIds);
    const next = chunks[index + 1]?.[0];
    console.log(
      `chunk ${index + 1}/${chunks.length}: ${modelIds.length} models, ${
        versionIds.length
      } versions` + (next ? `; resume with --from ${next}` : '')
    );
  }
  const after = await readCounts(dbWrite, ids);
  printCounts('after (primary)', after);
  if (after.modelsWithSafeBit || after.versionsWithSafeBit)
    throw new Error('Rows still carry a safe bit after the rollups');
}

if (process.argv[1]?.endsWith('recompute-mature-model-nsfw-levels.ts')) {
  void runScriptAndExit(() => main());
}
