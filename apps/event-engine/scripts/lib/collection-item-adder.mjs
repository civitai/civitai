import {
  readFileSync,
  existsSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  truncateSync,
} from 'fs';

// Helpers for backfill-collection-item-adder.mjs, split out so they can be tested without a
// database. See that script's header for why each rule exists.

// One entity per run, so each can be scoped and sized on its own; a bookmark row carries one of these.
const ENTITY_COLUMNS = { Article: 'articleId', Model: 'modelId', Post: 'postId' };

// Only Bookmark collections: their owner is the only one who adds to them, so the owner is the
// adder. In any other collection the owner may not be. $1 and $2 are the id range.
export function backfillSql(entity) {
  const column = ENTITY_COLUMNS[entity];
  if (!column)
    throw new Error(
      `--entity must be one of ${Object.keys(ENTITY_COLUMNS).join(', ')}, not ${entity}`
    );
  const candidates = `
    ci."collectionId" = c.id
    AND ci.id >= $1 AND ci.id < $2
    AND ci."addedById" IS NULL
    AND ci."imageId" IS NULL
    AND ci."${column}" IS NOT NULL
    AND c."userId" > 0`;
  return {
    candidates: `SELECT c.mode::text AS mode, count(*)::int AS n
      FROM "CollectionItem" ci, "Collection" c WHERE ${candidates} GROUP BY 1`,
    update: `UPDATE "CollectionItem" ci SET "addedById" = c."userId"
      FROM "Collection" c
      WHERE ${candidates} AND c.mode = 'Bookmark'
      RETURNING ci.id`,
    // Everything whose count the new rules can change: every entity and collection with a row of
    // this kind, and every entity still showing a count with no rows left to back it.
    touchEntities: `SELECT DISTINCT "${column}" AS id FROM "CollectionItem" WHERE "${column}" IS NOT NULL
      UNION
      SELECT "${column}" FROM "${entity}Metric" WHERE "collectedCount" <> 0`,
    touchCollections: `SELECT DISTINCT "collectionId" AS id FROM "CollectionItem"
      WHERE "${column}" IS NOT NULL`,
  };
}

// The metric jobs recount, from Postgres, every entity with an event in this table since their
// last run (src/server/metrics/collection-item-counts.ts reads it by name).
export const EVENTS_TABLE = 'entityMetricEvents_month';

// A 0 marks an entity for that recount and moves no sum, so writing one twice is harmless.
export const TOUCH_USER_ID = -1;

export function touchEvents(entityType, metricType, ids, createdAt) {
  return ids.map((entityId) => ({
    entityType,
    entityId,
    metricType,
    userId: TOUCH_USER_ID,
    metricValue: 0,
    createdAt,
  }));
}

// From the environment only: a missing credential stops the run rather than falling back.
export function clickhouseConfig(env) {
  if (env.CLICKHOUSE_URL) return { url: env.CLICKHOUSE_URL };
  const username = env.CLICKHOUSE_USERNAME ?? env.CLICKHOUSE_USER;
  const missing = [
    !env.CLICKHOUSE_HOST && 'CLICKHOUSE_HOST',
    !username && 'CLICKHOUSE_USERNAME (or CLICKHOUSE_USER)',
    !env.CLICKHOUSE_PASSWORD && 'CLICKHOUSE_PASSWORD',
  ].filter(Boolean);
  if (missing.length)
    throw new Error(`set CLICKHOUSE_URL, or ${missing.join(', ')}, in the environment`);
  return { url: env.CLICKHOUSE_HOST, username, password: env.CLICKHOUSE_PASSWORD };
}

// The ledger is JSONL. Per id range: `pending` (the Postgres txid and the row ids given an adder),
// then `committed`, or `abandoned` if its transaction rolled back. Once every range is done:
// `touched`. Returns the batch left unfinished, if any, where the run resumes, and whether the
// touch has run.
//
// A torn final line is dropped: every line is written before the step it records, so losing the
// last one only loses a claim the resume check re-derives from Postgres.
//
// A ledger belongs to one entity: resuming it under another would skip that entity's rows in every
// range the first run finished.
export function readLedger(lines, entity) {
  const batches = new Map();
  let touched = false;
  const entries = lines.filter((line) => line.trim());
  entries.forEach((line, i) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (err) {
      if (i === entries.length - 1) return;
      throw err;
    }
    if ((entry.phase === 'pending' || entry.phase === 'touched') && entry.entity !== entity)
      throw new Error(
        `ledger: written for ${entry.entity}, this run is ${entity}; use a new ledger`
      );
    if (entry.phase === 'pending') batches.set(entry.lo, { ...entry });
    else if (entry.phase === 'committed' || entry.phase === 'abandoned') {
      const batch = batches.get(entry.lo);
      if (!batch) throw new Error(`ledger: ${entry.phase} line for unknown batch ${entry.lo}`);
      if (entry.phase === 'abandoned') batches.delete(entry.lo);
      else batch.phase = 'committed';
    } else if (entry.phase === 'touched') touched = true;
    else throw new Error(`ledger: unknown phase ${entry.phase}`);
  });
  const all = [...batches.values()];
  const open = all.filter((b) => b.phase === 'pending');
  if (open.length > 1)
    throw new Error(`ledger: ${open.length} unfinished batches; the script only ever leaves one`);
  const done = all.filter((b) => b.phase === 'committed');
  return {
    open: open[0] ?? null,
    resumeFrom: done.length ? Math.max(...done.map((b) => b.hi)) : null,
    touched,
  };
}

// Settles an unterminated final line the way readLedger read it: finished if it parses, cut if
// torn. Appending after a torn fragment would glue the next line onto it and lose it on a later
// read, which can hide a restamp and insert the batch twice.
export function openLedger(path) {
  const text = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const cut = text.lastIndexOf('\n') + 1;
  let tail = text.slice(cut);
  if (tail) {
    try {
      JSON.parse(tail);
    } catch {
      truncateSync(path, Buffer.byteLength(text.slice(0, cut)));
      tail = '';
    }
  }
  const fd = openSync(path, 'a');
  if (tail) writeSync(fd, '\n');
  return {
    write(entry) {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    },
    close: () => closeSync(fd),
  };
}
