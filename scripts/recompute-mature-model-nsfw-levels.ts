import { readFileSync } from 'fs';
import { parseArgs } from 'util';
import { Prisma } from '@prisma/client';

import { dbRead, dbWrite } from '~/server/db/client';
import { dataForModelsCache } from '~/server/redis/caches';
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
 * then models (`updateModelNsfwLevels`), since the model level is the bit_or of its Published
 * versions. A model recompute alone leaves its versions at whatever they held before.
 *
 *   pnpm run tsscript scripts/recompute-mature-model-nsfw-levels.ts --ids-file <csv> [--apply]
 *   pnpm run tsscript scripts/recompute-mature-model-nsfw-levels.ts --ids-file <csv> --readback
 *
 * `--ids-file` is a CSV whose first column is the model id (a header row is skipped). Keep it
 * outside the repo.
 *
 * Modes:
 *   (default)   Dry run. Read-only on the replica: the scope check, the current counts and the
 *               counts the rollups will produce. Writes nothing.
 *   --apply     Runs the scope check on the primary, then the two rollups, busts the version and
 *               model caches, and reads the counts back from the primary. Exits 1 if any row
 *               still carries a safe bit.
 *   --readback  Read-only on the replica: the same counts as the dry run's "now", for checking
 *               after replication catches up. Exits 1 if any row still carries a safe bit.
 *
 * Scope: every id must be a live mature model with no civitai.com version (no sfwName and no
 * sfwCoverImageId). Such a model's rollup result is fixed at 60 (R|X|XXX|Blocked) for the model
 * and every version, so the dry run's prediction is exact. Any id outside the scope stops the run
 * before anything is written.
 */

type ScopeRow = {
  id: number;
  nsfw: boolean;
  deleted: boolean;
  hasComFace: boolean;
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
  }
  return refused;
}

type Db = typeof dbRead;

async function readScope(db: Db, ids: number[]) {
  return db.$queryRaw<ScopeRow[]>(Prisma.sql`
    SELECT m.id, m.nsfw,
           (m."deletedAt" IS NOT NULL OR m.status = 'Deleted') AS deleted,
           (m."sfwName" IS NOT NULL OR m."sfwCoverImageId" IS NOT NULL) AS "hasComFace"
    FROM "Model" m
    WHERE m.id IN (${Prisma.join(ids)})
  `);
}

type Counts = {
  models: number;
  modelsWithSafeBit: number;
  modelsAt60: number;
  modelsWithoutPublishedVersion: number;
  versions: number;
  publishedVersions: number;
  versionsWithSafeBit: number;
  versionsAt60: number;
};

async function readCounts(db: Db, ids: number[]): Promise<Counts> {
  const [row] = await db.$queryRaw<Record<keyof Counts, bigint>[]>(Prisma.sql`
    WITH m AS (SELECT id, "nsfwLevel" FROM "Model" WHERE id IN (${Prisma.join(ids)})),
         v AS (
           SELECT mv.id, mv."modelId", mv.status, mv."nsfwLevel"
           FROM "ModelVersion" mv JOIN m ON m.id = mv."modelId"
         )
    SELECT
      (SELECT count(*) FROM m) AS models,
      (SELECT count(*) FROM m WHERE ("nsfwLevel" & ${sfwBrowsingLevelsFlag}) != 0) AS "modelsWithSafeBit",
      (SELECT count(*) FROM m WHERE "nsfwLevel" = ${nsfwBrowsingLevelsFlag}) AS "modelsAt60",
      (SELECT count(*) FROM m WHERE NOT EXISTS (
         SELECT 1 FROM v WHERE v."modelId" = m.id AND v.status = 'Published'
      )) AS "modelsWithoutPublishedVersion",
      (SELECT count(*) FROM v) AS versions,
      (SELECT count(*) FROM v WHERE status = 'Published') AS "publishedVersions",
      (SELECT count(*) FROM v WHERE ("nsfwLevel" & ${sfwBrowsingLevelsFlag}) != 0) AS "versionsWithSafeBit",
      (SELECT count(*) FROM v WHERE "nsfwLevel" = ${nsfwBrowsingLevelsFlag}) AS "versionsAt60"
  `);
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)])) as Counts;
}

/**
 * What the two rollups produce for in-scope models: every version at 60, and every model with a
 * Published version at 60. A model with no Published version is skipped by `updateModelNsfwLevels`
 * (it joins on the version rollup) and keeps its level.
 */
export function predictCounts(now: Counts, modelsWithoutPublishedSafeBit: number): Counts {
  return {
    ...now,
    versionsWithSafeBit: 0,
    versionsAt60: now.versions,
    modelsWithSafeBit: modelsWithoutPublishedSafeBit,
    modelsAt60: now.models - now.modelsWithoutPublishedVersion,
  };
}

async function modelsWithoutPublishedVersionWithSafeBit(db: Db, ids: number[]) {
  const [{ count }] = await db.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT count(*) FROM "Model" m
    WHERE m.id IN (${Prisma.join(ids)})
      AND (m."nsfwLevel" & ${sfwBrowsingLevelsFlag}) != 0
      AND NOT EXISTS (
        SELECT 1 FROM "ModelVersion" mv WHERE mv."modelId" = m.id AND mv.status = 'Published'
      )
  `);
  return Number(count);
}

function printCounts(label: string, counts: Counts) {
  console.log(`${label}:`);
  console.log(
    `  models ${counts.models}: with a safe bit ${counts.modelsWithSafeBit}, at 60 ${counts.modelsAt60}, ` +
      `no Published version ${counts.modelsWithoutPublishedVersion}`
  );
  console.log(
    `  versions ${counts.versions} (Published ${counts.publishedVersions}): ` +
      `with a safe bit ${counts.versionsWithSafeBit}, at 60 ${counts.versionsAt60}`
  );
}

async function assertInScope(db: Db, ids: number[]) {
  const refused = outOfScope(ids, await readScope(db, ids));
  if (!refused.length) return;
  for (const { id, reason } of refused) console.error(`  out of scope: ${id} (${reason})`);
  throw new Error(`${refused.length} of ${ids.length} ids are out of scope; nothing was written`);
}

async function versionKillSwitchOff() {
  const raw = await sysRedis.hGet(
    REDIS_SYS_KEYS.SYSTEM.FEATURES,
    'update-system-model-version-nsfw-level'
  );
  const flag = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  return flag === 'false';
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'ids-file': { type: 'string' },
      apply: { type: 'boolean', default: false },
      readback: { type: 'boolean', default: false },
    },
  });
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
    console.log('scope: every id is a live mature model with no civitai.com version');
    if (await versionKillSwitchOff())
      console.log(
        'note: the system-model version kill switch is off; userId <= 0 versions are skipped'
      );
    const now = await readCounts(dbRead, ids);
    printCounts('now (replica)', now);
    printCounts(
      'after --apply (predicted)',
      predictCounts(now, await modelsWithoutPublishedVersionWithSafeBit(dbRead, ids))
    );
    console.log('dry run: nothing written');
    return;
  }

  await assertInScope(dbWrite, ids);
  printCounts('before (primary)', await readCounts(dbWrite, ids));
  const versions = await dbWrite.modelVersion.findMany({
    where: { modelId: { in: ids } },
    select: { id: true },
  });
  const versionIds = versions.map((v) => v.id);
  await updateModelVersionNsfwLevels(versionIds);
  await updateModelNsfwLevels(ids);
  await bustMvCache(versionIds, ids);
  for (const id of ids) await dataForModelsCache.refresh(id);
  const after = await readCounts(dbWrite, ids);
  printCounts('after (primary)', after);
  if (after.modelsWithSafeBit || after.versionsWithSafeBit)
    throw new Error('Rows still carry a safe bit after the rollups');
}

if (process.argv[1]?.endsWith('recompute-mature-model-nsfw-levels.ts')) {
  void runScriptAndExit(() => main());
}
