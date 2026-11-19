/**
 * One-off backfill: versions left Published or Scheduled under a model that is already Deleted are
 * set to Deleted, the status deleting a model writes on its versions. Rows like this were left by
 * account deletion before it flipped versions itself.
 *
 * Status only: no `updatedAt`, no files, no storage, no other table. A model whose owner is held
 * (`ownerHeldSql`) is skipped, and the check is repeated inside the UPDATE, so a hold placed after
 * a chunk is selected still stops it.
 *
 * After each chunk, for the versions it flipped: the version caches, then the orchestrator's copy,
 * 100 versions per call with a pause between calls; then the models' caches and search entries.
 * The run stops on the first error. Versions flipped but not yet busted are written to a file and
 * printed, and `--rebust <file>` busts exactly those.
 *
 * Usage:
 *   npm run tsscript scripts/oneoffs/backfill-deleted-model-versions.ts               # dry run: counts only
 *   npm run tsscript scripts/oneoffs/backfill-deleted-model-versions.ts --apply       # write
 *
 * Options:
 *   --apply           Write. Without it nothing is written.
 *   --chunk <n>       Versions per UPDATE, 1-2000 (default 1000).
 *   --pause-ms <n>    Pause between chunks and between orchestrator calls (default 1000).
 *   --from <id>       Resume after this version id (the cursor every chunk prints).
 *   --rebust <file>   Bust the caches of the versions listed in a pending file, then stop.
 */
import { Prisma } from '@prisma/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownerHeldSql } from '~/server/services/legal-hold.service';

export const SCRIPT_BASENAME = 'backfill-deleted-model-versions';
export const ORCHESTRATOR_BATCH = 100;
const MAX_CHUNK = 2000;

export type RunOptions = {
  apply: boolean;
  chunk: number;
  pauseMs: number;
  from: number;
  rebust: string | null;
};

export function parseArgs(argv: string[]): RunOptions {
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const raw = argv[i + 1];
    if (raw === undefined || raw.startsWith('--')) throw new Error(`--${name} needs a value`);
    return raw;
  };
  const int = (name: string, fallback: number) => {
    const raw = value(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0)
      throw new Error(`--${name} must be a whole number, got ${raw}`);
    return n;
  };
  const chunk = int('chunk', 1000);
  if (chunk < 1 || chunk > MAX_CHUNK)
    throw new Error(`--chunk must be 1-${MAX_CHUNK}, got ${chunk}`);
  return {
    apply: argv.includes('--apply'),
    chunk,
    pauseMs: int('pause-ms', 1000),
    from: int('from', 0),
    rebust: value('rebust') ?? null,
  };
}

const owner = Prisma.sql`m."userId"`;
const target = Prisma.sql`m.status = 'Deleted'::"ModelStatus"
  AND mv.status IN ('Published'::"ModelStatus", 'Scheduled'::"ModelStatus")`;

export function candidateIdsSql(after: number, limit: number) {
  return Prisma.sql`
    SELECT mv.id
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE ${target} AND mv.id > ${after} AND NOT ${ownerHeldSql(owner)}
    ORDER BY mv.id
    LIMIT ${limit}
  `;
}

export function flipSql(ids: number[]) {
  return Prisma.sql`
    UPDATE "ModelVersion" mv
    SET status = 'Deleted'::"ModelStatus"
    FROM "Model" m
    WHERE m.id = mv."modelId" AND mv.id = ANY(${ids}::int[]) AND ${target}
      AND NOT ${ownerHeldSql(owner)}
    RETURNING mv.id, mv."modelId"
  `;
}

/** Counts only: no ids, no names. */
export function dryRunSql() {
  return Prisma.sql`
    SELECT
      mv.status::text AS status,
      ${ownerHeldSql(owner)} AS held,
      (u."deletedAt" IS NULL) AS owner_live,
      CASE WHEN m."deletedBy" IS NULL AND m.meta->>'statusAtDelete' IS NULL
        THEN 'account-delete' ELSE 'model-delete' END AS delete_path,
      count(DISTINCT m.id)::int AS models,
      count(*)::int AS versions
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    JOIN "User" u ON u.id = m."userId"
    WHERE ${target}
    GROUP BY 1, 2, 3, 4
    ORDER BY 1, 2, 3, 4
  `;
}

export type DryRunRow = {
  status: string;
  held: boolean;
  owner_live: boolean;
  delete_path: string;
  models: number;
  versions: number;
};

export type Deps = {
  query: <T>(sql: Prisma.Sql) => Promise<T[]>;
  /** Every version cache except the orchestrator's. */
  bustVersions: (versionIds: number[]) => Promise<void>;
  /** Throws on the first failure. */
  bustOrchestrator: (versionIds: number[]) => Promise<unknown>;
  bustModels: (modelIds: number[]) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** Where the pending file goes; returns its path. */
  writePending: (pending: { versionIds: number[]; modelIds: number[] }) => string;
};

export async function dryRun(deps: Pick<Deps, 'query' | 'log'>) {
  const rows = await deps.query<DryRunRow>(dryRunSql());
  const sum = (pick: (r: DryRunRow) => boolean, field: 'models' | 'versions' = 'versions') =>
    rows.filter(pick).reduce((n, r) => n + r[field], 0);
  deps.log(`candidates: ${sum(() => true)} versions`);
  for (const status of ['Published', 'Scheduled'])
    deps.log(
      `  ${status}: ${sum((r) => r.status === status && !r.held)} to flip, ${sum(
        (r) => r.status === status && r.held
      )} held`
    );
  for (const pathName of ['account-delete', 'model-delete']) {
    const live = (r: DryRunRow) => r.owner_live && !r.held && r.delete_path === pathName;
    deps.log(
      `  owner not deleted, ${pathName}: ${sum(live, 'models')} models, ${sum(live)} versions`
    );
  }
  return rows;
}

/** Busts flipped versions and their models. On a failure, records what is still pending, then throws. */
export async function bustFlipped(
  { versionIds, modelIds }: { versionIds: number[]; modelIds: number[] },
  deps: Deps,
  pauseMs: number
) {
  let done = 0;
  try {
    for (let i = 0; i < versionIds.length; i += ORCHESTRATOR_BATCH) {
      const batch = versionIds.slice(i, i + ORCHESTRATOR_BATCH);
      await deps.bustVersions(batch);
      await deps.bustOrchestrator(batch);
      done = i + batch.length;
      if (done < versionIds.length) await deps.sleep(pauseMs);
    }
    await deps.bustModels(modelIds);
  } catch (error) {
    const file = deps.writePending({ versionIds: versionIds.slice(done), modelIds });
    deps.log(`stopped: cache bust failed; pending written to ${file}; run --rebust ${file}`);
    throw error;
  }
}

export async function apply(options: RunOptions, deps: Deps) {
  let cursor = options.from;
  let total = 0;
  for (;;) {
    const ids = (await deps.query<{ id: number }>(candidateIdsSql(cursor, options.chunk))).map(
      (r) => r.id
    );
    if (!ids.length) break;
    const flipped = await deps.query<{ id: number; modelId: number }>(flipSql(ids));
    cursor = ids[ids.length - 1];
    total += flipped.length;
    if (flipped.length)
      await bustFlipped(
        {
          versionIds: flipped.map((r) => r.id),
          modelIds: [...new Set(flipped.map((r) => r.modelId))],
        },
        deps,
        options.pauseMs
      );
    deps.log(`flipped ${total} so far; cursor ${cursor} (resume with --from ${cursor})`);
    await deps.sleep(options.pauseMs);
  }
  deps.log(`done: ${total} versions flipped`);
  return total;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { dbWrite } = await import('~/server/db/client');
  const { preventReplicationLagBatch } = await import('~/server/db/db-lag-helpers');
  const { bustMvCache } = await import('~/server/services/model-version.service');
  const { invalidateOrchestratorVersionsOrThrow } = await import(
    '~/server/services/orchestrator/models'
  );
  const { dropDeletedModelIdCaches } = await import('~/server/services/user.service');

  const deps: Deps = {
    query: <T>(sql: Prisma.Sql) => dbWrite.$queryRaw<T[]>(sql),
    bustVersions: async (ids) => {
      await preventReplicationLagBatch('modelVersion', ids);
      await bustMvCache(ids, undefined, undefined, { orchestrator: false });
    },
    bustOrchestrator: (ids) => invalidateOrchestratorVersionsOrThrow(ids),
    bustModels: dropDeletedModelIdCaches,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
    writePending: (pending) => {
      const file = path.join(os.tmpdir(), `${SCRIPT_BASENAME}-pending-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify(pending));
      return file;
    },
  };

  if (options.rebust) {
    const pending = JSON.parse(fs.readFileSync(options.rebust, 'utf8')) as {
      versionIds: number[];
      modelIds: number[];
    };
    await bustFlipped(pending, deps, options.pauseMs);
    deps.log(
      `rebust done: ${pending.versionIds.length} versions, ${pending.modelIds.length} models`
    );
    return;
  }

  await dryRun(deps);
  if (!options.apply) {
    deps.log('dry run: nothing written (pass --apply to write)');
    return;
  }
  await apply(options, deps);
}

// Only when run as a script: importing the builders above must not start a run.
if (process.argv[1]?.includes(SCRIPT_BASENAME)) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
