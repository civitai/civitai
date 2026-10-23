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

// What collectionItemHandler (src/handlers/collection-items.ts) emits for one created row, minus
// Image: image rows are excluded from this backfill.
const ENTITY_METRICS = [
  ['collectionId', 'Collection', 'itemCount'],
  ['modelId', 'Model', 'collectedCount'],
  ['postId', 'Post', 'collectedCount'],
  ['articleId', 'Article', 'collectedCount'],
];

export const METRIC_PAIRS = ENTITY_METRICS.map(([, entityType, metricType]) => [
  entityType,
  metricType,
]);

// One event per (entityType, entityId, metricType, userId), valued at its row count. The events
// table is a ReplacingMergeTree keyed on those four plus createdAt to the second, so two +1 rows
// for the same key in one batch would collapse to one in any argMax reader.
export function buildEvents(rows, createdAt) {
  const byKey = new Map();
  for (const row of rows) {
    for (const [field, entityType, metricType] of ENTITY_METRICS) {
      const entityId = row[field];
      if (entityId == null) continue;
      const key = `${entityType}:${entityId}:${metricType}:${row.addedById}`;
      const event = byKey.get(key);
      if (event) event.metricValue += 1;
      else
        byKey.set(key, {
          entityType,
          entityId,
          metricType,
          userId: row.addedById,
          metricValue: 1,
          createdAt,
        });
    }
  }
  return [...byKey.values()];
}

// Each batch gets its own second, so a key that recurs in a later batch is a distinct row rather
// than a replacement of the earlier one. Never in the past: the metric jobs find affected entities
// by `createdAt >= lastUpdate`, and the daily views ignore anything older than yesterday.
export function nextStampMs(prevStampMs, nowMs) {
  const now = Math.floor(nowMs / 1000) * 1000;
  return prevStampMs == null ? now : Math.max(now, prevStampMs + 1000);
}

// The ledger is JSONL: a `pending` line carrying the batch (its Postgres txid, stamp and events),
// then lines naming it by `lo`: `committed`, `restamped` (new stamp and events), `inserted`, or
// `abandoned` (its transaction rolled back; the range is redone). Returns the one batch that has not
// finished, if any, and the highest id fully handled so a rerun starts after it.
//
// A torn final line is dropped: every line is written before the step it records, so losing the
// last one only loses a claim the resume check re-derives from Postgres and ClickHouse.
export function readLedger(lines) {
  const batches = new Map();
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
    if (entry.phase === 'pending') {
      batches.set(entry.lo, { ...entry });
    } else {
      const batch = batches.get(entry.lo);
      if (!batch) throw new Error(`ledger: ${entry.phase} line for unknown batch ${entry.lo}`);
      if (entry.phase === 'abandoned') batches.delete(entry.lo);
      else Object.assign(batch, entry);
    }
    if (entry.stampMs != null) lastStampMs = Math.max(lastStampMs ?? 0, entry.stampMs);
  });
  const all = [...batches.values()];
  const open = all.filter((b) => b.phase !== 'inserted');
  if (open.length > 1)
    throw new Error(`ledger: ${open.length} unfinished batches; the script only ever leaves one`);
  const done = all.filter((b) => b.phase === 'inserted');
  return {
    open: open[0] ?? null,
    resumeFrom: done.length ? Math.max(...done.map((b) => b.hi)) : null,
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
  const keyOf = (e) => `${e.entityType}:${e.entityId}:${e.metricType}:${e.userId}:${e.metricValue}`;
  const foundKeys = new Set(found.map(keyOf));
  const hits = expected.filter((e) => foundKeys.has(keyOf(e))).length;
  if (hits === 0) return 'none';
  if (hits === expected.length) return 'all';
  return 'partial';
}
