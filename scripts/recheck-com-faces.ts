import { readFileSync, writeFileSync } from 'fs';
import { parseArgs } from 'util';
import { Prisma } from '@prisma/client';

import { dbRead, dbWrite } from '~/server/db/client';
import {
  COM_FACE_RUN_BUDGET_MS,
  RETRY_KEY_PREFIX,
} from '~/server/services/model-com-face-recheck.service';
import { runScriptAndExit } from './lib/run-as-script';
import { chunksFrom, parseIdsCsv } from './recompute-mature-model-nsfw-levels';

/**
 * Queue the civitai.com listing re-check for every model that has a .com face, through the path the
 * `com-face-recheck` job already runs: a due retry row in "KeyValue" (`com-face-recheck:<modelId>`),
 * which the job checks ahead of fresh edits. Each check keeps the face, takes it off civitai.com when
 * the listing is flagged, or retries for 24 hours from the row's insert and then takes it off as
 * unverified (`recheckComFace` / `processComFaceRechecks`). Nothing here messages owners. Postgres
 * only: no Redis.
 *
 * Every face, not only those saved before the intent check went live: nothing records when a face
 * was saved or last passed the check, and Model.updatedAt moves on unrelated writes (a lock toggle,
 * a lock-review lift), so a cutoff on it would leave older faces unchecked. A face that already
 * passed costs one more check and stays.
 *
 *   pnpm run tsscript scripts/recheck-com-faces.ts [--out ids.csv]
 *   pnpm run tsscript scripts/recheck-com-faces.ts --apply --ids <id>[,<id>...]
 *   pnpm run tsscript scripts/recheck-com-faces.ts --apply --ids-file ids.csv [--batch 20] [--every 300]
 *     [--from <id>] [--limit N]
 *   pnpm run tsscript scripts/recheck-com-faces.ts --readback --ids-file ids.csv [--since <ISO>]
 *
 * Modes:
 *   (default)   Dry run, read-only on the replica: derives the set at run time (a .com name and cover,
 *               not deleted, no retry row waiting) and prints its count. --out writes the ids as a
 *               CSV; keep it outside the repo.
 *   --apply     Inserts the retry rows in ascending id order, in batches of --batch, --every seconds
 *               apart (at least one job run). ON CONFLICT DO NOTHING: a model already waiting keeps
 *               its deadline, and a re-run adds nothing. Before each batch after the first, if every
 *               row of the previous batch is still waiting, the checker is not keeping up (or is down):
 *               the run stops instead of starting more 24-hour countdowns, and prints the --from id to
 *               resume at. --limit caps how many ids are queued. Prints its start time for --since.
 *   --readback  Read-only on the replica: kept / removed / unverified / waiting over the ids; a control
 *               over faced models outside them (none should be waiting); and with --since, the
 *               ModActivity removals since the run started, which must equal removed + unverified.
 */

/** The models to re-check, read at run time. */
export const recheckSetSql = () => Prisma.sql`
  SELECT m.id
  FROM "Model" m
  WHERE m."sfwName" IS NOT NULL
    AND m."sfwCoverImageId" IS NOT NULL
    AND m."deletedAt" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "KeyValue" kv WHERE kv.key = ${RETRY_KEY_PREFIX} || m.id::text
    )
  ORDER BY m.id
`;

/** A due retry row per model, inserted only where none is waiting. */
export const insertRetryRowsSql = (modelIds: number[], since: Date) => {
  const value = JSON.stringify({ since: since.toISOString(), attempt: 0, nextAt: '' });
  return Prisma.sql`
    INSERT INTO "KeyValue" (key, value)
    SELECT ${RETRY_KEY_PREFIX} || id::text, ${value}::jsonb
    FROM unnest(${modelIds}::int[]) AS id
    ON CONFLICT (key) DO NOTHING
  `;
};

/** The ids among `modelIds` that still have a retry row: no verdict has cleared them yet. */
export const pendingSql = (modelIds: number[]) => Prisma.sql`
  SELECT substr(key, ${RETRY_KEY_PREFIX.length + 1}::int)::int AS id
  FROM "KeyValue"
  WHERE key = ANY(SELECT ${RETRY_KEY_PREFIX} || id::text FROM unnest(${modelIds}::int[]) AS id)
`;

/** Every row of the previous batch is still waiting: the checker has not answered any of them. */
export function checkerStalled(previousBatch: number[], pending: Set<number>) {
  return previousBatch.length > 0 && previousBatch.every((id) => pending.has(id));
}

type RunDeps = {
  insert: (ids: number[]) => Promise<number>;
  pending: (ids: number[]) => Promise<Set<number>>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
};

/** Queues the batches with a pause between them, stopping when the checker stalls. */
export async function runBatches(chunks: number[][], everyMs: number, deps: RunDeps) {
  let queued = 0;
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) {
      await deps.sleep(everyMs);
      const previous = chunks[index - 1];
      if (checkerStalled(previous, await deps.pending(previous))) {
        deps.log(
          `stopped: all ${previous.length} rows of batch ${index} are still waiting after ` +
            `${Math.round(everyMs / 1000)}s; resume with --from ${
              chunk[0]
            } once the checker answers`
        );
        return { queued, stoppedAt: chunk[0] };
      }
    }
    const inserted = await deps.insert(chunk);
    queued += inserted;
    deps.log(`batch ${index + 1}/${chunks.length}: ${inserted} queued of ${chunk.length}`);
  }
  return { queued, stoppedAt: undefined };
}

export const readbackSql = (modelIds: number[]) => Prisma.sql`
  SELECT
    count(*) FILTER (WHERE kv.key IS NOT NULL) AS pending,
    count(*) FILTER (WHERE kv.key IS NULL AND m."sfwCoverImageId" IS NOT NULL) AS kept,
    count(*) FILTER (WHERE kv.key IS NULL AND m.meta->'comFaceRemoved'->>'reason' = 'detected') AS removed,
    count(*) FILTER (
      WHERE kv.key IS NULL AND m.meta->'comFaceRemoved'->>'reason' = 'recheck-unverified'
    ) AS unverified,
    count(*) AS total
  FROM "Model" m
  LEFT JOIN "KeyValue" kv ON kv.key = ${RETRY_KEY_PREFIX} || m.id::text
  WHERE m.id = ANY(${modelIds}::int[])
`;

/** Removals the re-check logged for these models since `since`: must equal removed + unverified. */
export const modActivitySql = (modelIds: number[], since: Date) => Prisma.sql`
  SELECT count(DISTINCT "entityId") AS count
  FROM "ModActivity"
  WHERE "entityType" = 'model'
    AND activity IN ('removeComFace', 'comFaceRecheckGaveUp')
    AND "entityId" = ANY(${modelIds}::int[])
    AND "createdAt" >= ${since}
`;

/** Models with a .com face that the run did not queue: none of them may be waiting on a re-check. */
export const controlSql = (modelIds: number[]) => Prisma.sql`
  SELECT count(*) AS total, count(kv.key) AS pending
  FROM "Model" m
  LEFT JOIN "KeyValue" kv ON kv.key = ${RETRY_KEY_PREFIX} || m.id::text
  WHERE m."sfwName" IS NOT NULL AND m."sfwCoverImageId" IS NOT NULL
    AND NOT (m.id = ANY(${modelIds}::int[]))
`;

const num = (rows: Record<string, bigint>[]) =>
  Object.fromEntries(Object.entries(rows[0] ?? {}).map(([k, v]) => [k, Number(v)]));

function readIds(values: { ids?: string; 'ids-file'?: string }) {
  if (values.ids) return [...new Set(values.ids.split(',').map((id) => Number(id.trim())))];
  if (values['ids-file']) return parseIdsCsv(readFileSync(values['ids-file'], 'utf8'));
  return undefined;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: 'string' },
      apply: { type: 'boolean', default: false },
      readback: { type: 'boolean', default: false },
      ids: { type: 'string' },
      'ids-file': { type: 'string' },
      limit: { type: 'string' },
      from: { type: 'string', default: '0' },
      batch: { type: 'string', default: '20' },
      every: { type: 'string', default: '300' },
      since: { type: 'string' },
    },
  });
  const ids = readIds(values);
  if (ids?.some((id) => !Number.isInteger(id) || id <= 0)) throw new Error('Ids must be positive');

  if (values.readback) {
    if (!ids?.length) throw new Error('--readback needs --ids or --ids-file');
    const counts = num(await dbRead.$queryRaw(readbackSql(ids)));
    console.log('readback (replica):', counts);
    const control = num(await dbRead.$queryRaw(controlSql(ids)));
    console.log('control, faced models not in the run:', control);
    if (values.since) {
      const logged = num(await dbRead.$queryRaw(modActivitySql(ids, new Date(values.since))));
      console.log(
        `ModActivity removals since ${values.since}: ${logged.count}` +
          ` (removed + unverified = ${counts.removed + counts.unverified})`
      );
    }
    return;
  }

  if (!values.apply) {
    const rows = await dbRead.$queryRaw<{ id: number }[]>(recheckSetSql());
    console.log(`set (replica): ${rows.length} models with a .com face and no re-check waiting`);
    if (values.out) {
      writeFileSync(values.out, ['id', ...rows.map((r) => r.id)].join('\n') + '\n');
      console.log(`ids written to ${values.out}`);
    }
    console.log('dry run: nothing written');
    return;
  }

  if (!ids?.length) throw new Error('--apply needs --ids or --ids-file (from the dry run)');
  const size = Number(values.batch);
  let queue = chunksFrom(ids, ids.length, Number(values.from)).flat();
  if (values.limit) queue = queue.slice(0, Number(values.limit));
  const everyMs = Number(values.every) * 1000;
  if (everyMs < COM_FACE_RUN_BUDGET_MS)
    throw new Error(`--every must be at least one job run (${COM_FACE_RUN_BUDGET_MS / 1000}s)`);

  const startedAt = new Date();
  console.log(`apply: ${queue.length} ids, batches of ${size}, ${values.every}s apart`);
  const result = await runBatches(chunksFrom(queue, size), everyMs, {
    insert: (chunk) => dbWrite.$executeRaw(insertRetryRowsSql(chunk, new Date())),
    pending: async (chunk) =>
      new Set((await dbWrite.$queryRaw<{ id: number }[]>(pendingSql(chunk))).map((r) => r.id)),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
  });
  console.log(
    `queued ${result.queued}; started ${startedAt.toISOString()} (pass as --since to --readback)`
  );
  if (result.stoppedAt !== undefined) throw new Error('Stopped: the checker is not answering');
}

if (process.argv[1]?.endsWith('recheck-com-faces.ts')) {
  void runScriptAndExit(() => main());
}
