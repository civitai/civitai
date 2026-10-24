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

// The metrics collectionItemHandler (src/handlers/collection-items.ts) emits for a non-image row.
const ENTITY_METRICS = [
  ['collectionId', 'Collection', 'itemCount'],
  ['modelId', 'Model', 'collectedCount'],
  ['postId', 'Post', 'collectedCount'],
  ['articleId', 'Article', 'collectedCount'],
];

// One entity per run, so each can be scoped and sized on its own; a bookmark row carries one of these.
const ENTITY_COLUMNS = { Article: 'articleId', Model: 'modelId', Post: 'postId' };

// Only Bookmark collections: their owner is the only one who adds to them, so the owner is the
// adder. In any other collection the owner may not be. $1 and $2 are the id range.
//
// `counted` is what the metric aggregates will count from now on: a row with an adder, or one this
// run is about to give one, unless that user is in metricExcludedUsers ($2 of the truth queries),
// whose events the aggregates filter out. It is the same before and after the UPDATE, so the dry
// run (read-only replica) and the real run reconcile to the same truth. Anything else in a touched
// entity or collection, such as a null-adder image row, is reconciled out of the total: it is what
// the handler will count from here on, so leaving it in would drift as soon as one is deleted.
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
  const counted = `(ci."addedById" IS NOT NULL OR (c.mode = 'Bookmark' AND c."userId" > 0
    AND ci."imageId" IS NULL AND ci."${column}" IS NOT NULL))
    AND COALESCE(ci."addedById", c."userId") <> ALL($2::int[])`;
  return {
    candidates: `SELECT c.mode::text AS mode, ci."${column}" AS "entityId", ci."collectionId", count(*)::int AS n
      FROM "CollectionItem" ci, "Collection" c WHERE ${candidates} GROUP BY 1, 2, 3`,
    update: `UPDATE "CollectionItem" ci SET "addedById" = c."userId"
      FROM "Collection" c
      WHERE ${candidates} AND c.mode = 'Bookmark'
      RETURNING ci.id, ci."collectionId", ci."${column}" AS "entityId"`,
    // No index leads with the entity column, so every call is a full scan: call it once, with
    // every id, never per batch or per chunk.
    entityTruth: `SELECT ci."${column}" AS id, count(*)::int AS n
      FROM "CollectionItem" ci JOIN "Collection" c ON c.id = ci."collectionId"
      WHERE ci."${column}" = ANY($1::int[]) AND ${counted} GROUP BY 1`,
    collectionTruth: `SELECT ci."collectionId" AS id, count(*)::int AS n
      FROM "CollectionItem" ci JOIN "Collection" c ON c.id = ci."collectionId"
      WHERE ci."collectionId" = ANY($1::int[]) AND ${counted} GROUP BY 1`,
  };
}

// The total the metric job will read once the daily views catch up: entityMetricDailyAgg_v2 for
// sealed days, plus the raw events since yesterday, deduped and filtered the way the today view
// is. Reading the view alone would miss events it has not refreshed yet, including this run's own.
// The today view's definition lives in ClickHouse, not here: the dry run prints both for samples.
export function chTotalsSql(eventsTable) {
  return `SELECT entityId, sum(v) AS total FROM (
      SELECT entityId, total AS v FROM default.entityMetricDailyAgg_v2
      WHERE entityType = {entityType:String} AND metricType = {metricType:String}
        AND entityId IN {ids:Array(Int64)} AND day < today() - 1
      UNION ALL
      SELECT entityId, argMax(metricValue, version) AS v FROM default.${eventsTable}
      WHERE entityType = {entityType:String} AND metricType = {metricType:String}
        AND entityId IN {ids:Array(Int64)} AND createdAt >= toDateTime(today() - 1)
        AND userId NOT IN (SELECT userId FROM default.metricExcludedUsers FINAL WHERE active = 1)
      GROUP BY entityId, userId, createdAt
    ) GROUP BY entityId`;
}

// What the metric job reads today, for comparing against chTotalsSql on samples.
export const VIEW_TOTALS_SQL = `SELECT entityId, sum(total) AS total FROM default.entityMetricDailyAgg_v2
  WHERE entityType = {entityType:String} AND metricType = {metricType:String}
    AND entityId IN {ids:Array(Int64)}
  GROUP BY entityId`;

// The reconcile events carry no user: they correct a total, not anyone's action.
export const RECONCILE_USER_ID = 0;

// One event per entity whose ClickHouse total is off from what it should count, valued at the
// difference, so the total lands on the truth whatever put it where it is. An entity missing from
// either side counts 0 there.
export function reconcile({ entityType, metricType, ids, truth, ch, createdAt }) {
  const rows = ids.map((entityId) => {
    const want = truth.get(entityId) ?? 0;
    const have = ch.get(entityId) ?? 0;
    return { entityType, entityId, want, have, delta: want - have };
  });
  const events = rows
    .filter((r) => r.delta !== 0)
    .map((r) => ({
      entityType,
      entityId: r.entityId,
      metricType,
      userId: RECONCILE_USER_ID,
      metricValue: r.delta,
      createdAt,
    }));
  return { rows, events };
}

const BUCKETS = [
  ['< -100', (d) => d < -100],
  ['-100..-11', (d) => d >= -100 && d <= -11],
  ['-10..-1', (d) => d >= -10 && d <= -1],
  ['0', (d) => d === 0],
  ['1..10', (d) => d >= 1 && d <= 10],
  ['11..100', (d) => d >= 11 && d <= 100],
  ['101..1000', (d) => d >= 101 && d <= 1000],
  ['> 1000', (d) => d > 1000],
];

export function deltaSummary(rows) {
  const histogram = Object.fromEntries(
    BUCKETS.map(([label, test]) => [label, rows.filter((r) => test(r.delta)).length])
  );
  const sum = (f) => rows.filter(f).reduce((acc, r) => acc + r.delta, 0);
  return {
    entities: rows.length,
    events: rows.filter((r) => r.delta !== 0).length,
    added: sum((r) => r.delta > 0),
    removed: sum((r) => r.delta < 0),
    net: sum(() => true),
    histogram,
  };
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

export const METRIC_PAIRS = ENTITY_METRICS.map(([, entityType, metricType]) => [
  entityType,
  metricType,
]);

// Each batch gets its own second, so a key that recurs in a later batch is a distinct row rather
// than a replacement of the earlier one. Never in the past: the metric jobs find affected entities
// by `createdAt >= lastUpdate`, and the daily views ignore anything older than yesterday.
export function nextStampMs(prevStampMs, nowMs) {
  const now = Math.floor(nowMs / 1000) * 1000;
  return prevStampMs == null ? now : Math.max(now, prevStampMs + 1000);
}

// The ledger is JSONL, in two parts.
//   Phase 1, per id range: `pending` (Postgres txid, the row ids given an adder, and the entity and
//   collection ids they touch), then `committed`, or `abandoned` if its transaction rolled back.
//   Phase 2, once: `reconcile` (stamp and events), optionally `restamped`, then `reconciled`.
// Returns the phase-1 batch left unfinished, if any; where phase 1 resumes; every id touched by
// committed batches; and the reconcile, if one was planned.
//
// A torn final line is dropped: every line is written before the step it records, so losing the
// last one only loses a claim the resume check re-derives from Postgres and ClickHouse.
//
// A ledger belongs to one entity: resuming it under another would skip that entity's rows in every
// range the first run finished.
export function readLedger(lines, entity) {
  const batches = new Map();
  let reconcile = null;
  let lastStampMs = null;
  const entries = lines.filter((line) => line.trim());
  entries.forEach((line, i) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (err) {
      if (i === entries.length - 1) return;
      throw err;
    }
    if ((entry.phase === 'pending' || entry.phase === 'reconcile') && entry.entity !== entity)
      throw new Error(
        `ledger: written for ${entry.entity}, this run is ${entity}; use a new ledger`
      );
    if (entry.phase === 'pending') batches.set(entry.lo, { ...entry });
    else if (entry.phase === 'committed' || entry.phase === 'abandoned') {
      const batch = batches.get(entry.lo);
      if (!batch) throw new Error(`ledger: ${entry.phase} line for unknown batch ${entry.lo}`);
      if (entry.phase === 'abandoned') batches.delete(entry.lo);
      else batch.phase = 'committed';
    } else if (entry.phase === 'reconcile') reconcile = { ...entry };
    else if (entry.phase === 'restamped' || entry.phase === 'reconciled') {
      if (!reconcile) throw new Error(`ledger: ${entry.phase} line before any reconcile`);
      Object.assign(reconcile, entry);
    } else throw new Error(`ledger: unknown phase ${entry.phase}`);
    if (entry.stampMs != null) lastStampMs = Math.max(lastStampMs ?? 0, entry.stampMs);
  });
  const all = [...batches.values()];
  const open = all.filter((b) => b.phase === 'pending');
  if (open.length > 1)
    throw new Error(`ledger: ${open.length} unfinished batches; the script only ever leaves one`);
  if (open.length && reconcile)
    throw new Error('ledger: a batch is unfinished after the reconcile; stopping for a human');
  const done = all.filter((b) => b.phase === 'committed');
  return {
    open: open[0] ?? null,
    resumeFrom: done.length ? Math.max(...done.map((b) => b.hi)) : null,
    touched: {
      entityIds: [...new Set(done.flatMap((b) => b.entityIds))],
      collectionIds: [...new Set(done.flatMap((b) => b.collectionIds))],
    },
    reconcile,
    lastStampMs,
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

// Compares a batch's events with the rows found in ClickHouse at its stamp. A real event in the
// same second can share a key, so a key only counts as landed when its value matches too.
export function landedState(expected, found) {
  if (!expected.length) return 'all';
  const keyOf = (e) => `${e.entityType}:${e.entityId}:${e.metricType}:${e.userId}:${e.metricValue}`;
  const foundKeys = new Set(found.map(keyOf));
  const hits = expected.filter((e) => foundKeys.has(keyOf(e))).length;
  if (hits === 0) return 'none';
  if (hits === expected.length) return 'all';
  return 'partial';
}
