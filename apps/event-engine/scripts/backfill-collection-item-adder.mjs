#!/usr/bin/env node

/**
 * Backfill CollectionItem.addedById on bookmark rows, and reconcile the counts they feed
 *
 * Bookmark rows used to be written with no addedById. collectionItemHandler attributes every
 * event to addedById and drops events with no user, so since then those bookmarks have not
 * counted toward <entity> collectedCount or Collection itemCount, and their deletes have not
 * uncounted. Rows older than the November 2025 seed of the events table are counted anyway: the
 * seed wrote one bulk event per entity from the Postgres totals. So a +1 per row would double
 * count most of them, and the right correction differs per entity.
 *
 * Phase 1, per id range: set addedById to the collection owner on null-adder bookmark rows of the
 * entity, in one transaction per range. No events: the handler ignores updates, and from here on a
 * delete of one of these rows emits its -1 as the owner.
 * Phase 2, once phase 1 has covered every id: for every entity and collection phase 1 touched, read
 * the rows the handler now counts (Postgres, one scan) and the ClickHouse total straight after, and
 * insert one event per entity valued at the difference. Negative where the seed over-counted, none
 * where it is already right. It runs after phase 1 so deletes during phase 1 are absorbed too.
 *
 * Exactly-once, because a delta that lands twice moves every total it touches twice: a retry at a
 * new stamp is a new row to every view. Every line below is fsynced to the ledger before the step
 * it records.
 *   Phase 1: `pending` (txid, ids) -> COMMIT -> `committed`. On restart txid_status() of the
 *   unfinished batch decides: rolled back is redone, committed is marked so.
 *   Phase 2: `reconcile` (stamp, events) -> insert -> `reconciled`. On restart, once the stamp is
 *   LANDING_WAIT_MS old (so an insert still in flight has finished or failed), a sequentially
 *   consistent read of its events at its stamp decides: all there is done; none there is
 *   re-stamped to now (`restamped`) and inserted, because a stale stamp would miss the daily views
 *   and the metric jobs; a partial match stops the run for a human.
 * An advisory lock keeps a second run (another ledger) from touching the same rows.
 *
 * Live bookmarks between the Postgres read and the ClickHouse read can leave an entity off by one
 * each. Accepted: the rate is a few an hour.
 *
 * Rollback, from the ledger: insert the `reconcile` events negated at a new stamp, then set
 * addedById back to NULL on the phase-1 ids still present.
 *
 * Run AFTER the release that sets addedById on new bookmarks is live, or rows created behind the
 * run stay uncounted.
 *
 * Usage:
 *   node scripts/backfill-collection-item-adder.mjs --entity Article            # dry run
 *   node scripts/backfill-collection-item-adder.mjs --entity Article --execute --ledger ./adder-article.jsonl
 *
 * Env: DATABASE_URL / DATABASE_REPLICA_URL as below, and CLICKHOUSE_URL or CLICKHOUSE_HOST +
 * CLICKHOUSE_USERNAME + CLICKHOUSE_PASSWORD. Nothing is read from files; a missing one stops the run.
 *
 * Options:
 *   --execute          Write. Needs DATABASE_URL (the primary); the dry run reads
 *                      DATABASE_REPLICA_URL when set, and writes nothing anywhere.
 *   --ledger <path>    Required with --execute. Reuse the same path to resume.
 *   --from <id>        Dry run only: first CollectionItem.id (default 0).
 *   --to <id>          Dry run only: stop before this id (default max(id) + 1). A real run always
 *                      covers every id from where the ledger left off, so phase 2 sees them all.
 *   --range <n>        Ids per batch (default 20000).
 *   --pause-ms <n>     Pause between batches that wrote something (default 1000).
 *   --entity <type>    Article (default), Model or Post: which bookmarked rows this run repairs.
 *                      A ledger belongs to one entity; the run refuses a ledger from another.
 *   --sample <ids>     Dry run: print want / have / delta for these entity ids (comma-separated),
 *                      and the view's current total beside `have`; they differ only by events
 *                      the today view has not refreshed in yet.
 *   --events-table <t> Raw events table (default entityMetricEvents_month). The run refuses a
 *                      table the daily views (entityMetricDaily_today_v2_mv and
 *                      entityMetricDailySeal_v2_mv) do not read.
 */

import { createClient } from '@clickhouse/client';
import pg from 'pg';
import { readFileSync, existsSync } from 'fs';
import {
  METRIC_PAIRS,
  backfillSql,
  DAILY_VIEWS,
  VIEW_TOTALS_SQL,
  chTotalsSql,
  clickhouseConfig,
  deltaSummary,
  landedState,
  nextStampMs,
  openLedger,
  readLedger,
  reconcile,
  tableNamePattern,
} from './lib/collection-item-adder.mjs';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const EXECUTE = args.includes('--execute');
const LEDGER = arg('--ledger');
const RANGE = Number(arg('--range') ?? 20000);
const PAUSE_MS = Number(arg('--pause-ms') ?? 1000);
const FROM = arg('--from') != null ? Number(arg('--from')) : null;
const TO = arg('--to') != null ? Number(arg('--to')) : null;
const ENTITY = arg('--entity') ?? 'Article';
const SAMPLE = new Set((arg('--sample') ?? '').split(',').filter(Boolean).map(Number));

const SQL = backfillSql(ENTITY);

// Longer than the client's request_timeout, so an insert from the crashed run is settled.
const LANDING_WAIT_MS = 15 * 60 * 1000;
const EVENTS_TABLE = arg('--events-table') ?? 'entityMetricEvents_month';
const LOCK_KEY = 'backfill-collection-item-adder';
const ID_CHUNK = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunks = (list) =>
  Array.from({ length: Math.ceil(list.length / ID_CHUNK) }, (_, i) =>
    list.slice(i * ID_CHUNK, (i + 1) * ID_CHUNK)
  );

function fail(...lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

async function main() {
  if (!Number.isInteger(RANGE) || RANGE <= 0) fail(`Error: --range must be a positive integer`);
  if (EXECUTE && !LEDGER)
    fail('Error: --execute needs --ledger <path>; it is what makes a rerun safe.');
  if (EXECUTE && (FROM != null || TO != null))
    fail('Error: --from and --to are for the dry run; a real run resumes from its ledger.');
  if (!/^\w+$/.test(EVENTS_TABLE))
    fail(`Error: --events-table "${EVENTS_TABLE}" is not a table name`);

  const pgUrl = EXECUTE
    ? process.env.DATABASE_URL
    : process.env.DATABASE_REPLICA_URL ?? process.env.DATABASE_URL;
  if (!pgUrl)
    fail(
      EXECUTE
        ? 'Error: DATABASE_URL (the primary) is required with --execute.'
        : 'Error: set DATABASE_REPLICA_URL (or DATABASE_URL) for the dry run.'
    );

  let chConfig;
  try {
    chConfig = clickhouseConfig(process.env);
  } catch (err) {
    fail(`Error: ${err.message}`);
  }
  const ch = createClient({ ...chConfig, request_timeout: 300000 });
  const query = async (sql, params) =>
    (
      await ch.query({
        query: sql,
        query_params: params,
        format: 'JSONEachRow',
        clickhouse_settings: { select_sequential_consistency: 1 },
      })
    ).json();

  // An unregistered or non-additive pair is totalled as distinct users, not as a sum, and every
  // delta event written here would read as one.
  const kinds = await query(`SELECT entityType, metricType, kind FROM default.entityMetricKind FINAL
                             WHERE (entityType, metricType) IN (${METRIC_PAIRS.map(
                               ([e, m]) => `('${e}','${m}')`
                             ).join(',')})`);
  for (const [entityType, metricType] of METRIC_PAIRS) {
    const kind = kinds.find(
      (k) => k.entityType === entityType && k.metricType === metricType
    )?.kind;
    if (kind !== 'additive')
      fail(
        `Error: entityMetricKind for ${entityType}/${metricType} is "${
          kind ?? 'missing'
        }", not "additive".`
      );
  }

  // The reconcile is only right if the events it writes and the raw rows it reads are the ones the
  // daily views behind entityMetricDailyAgg_v2 (what the metric job reads) are built from. Both
  // read the events table inside a subquery, so look for the name as a whole identifier.
  for (const view of DAILY_VIEWS) {
    const found = await query(
      `SELECT name FROM system.tables
       WHERE database = 'default' AND engine = 'MaterializedView' AND name = {view:String}
         AND match(create_table_query, {re:String})`,
      { view, re: tableNamePattern(EVENTS_TABLE) }
    );
    if (!found.length) fail(`Error: ${view} does not read ${EVENTS_TABLE}. Wrong table?`);
  }

  const pool = new pg.Pool({ connectionString: pgUrl, connectionTimeoutMillis: 30000, max: 3 });
  const { rows: maxRows } = await pool.query('SELECT max(id) AS max FROM "CollectionItem"');
  const to = TO ?? Number(maxRows[0].max ?? 0) + 1;

  const excluded = (
    await query('SELECT userId FROM default.metricExcludedUsers FINAL WHERE active = 1')
  ).map((r) => Number(r.userId));
  const toMap = (rows, id, value) => new Map(rows.map((r) => [Number(r[id]), Number(r[value])]));
  const pgCounts = async (sql, ids, chunked) => {
    const parts = chunked ? chunks(ids) : [ids];
    const rows = [];
    for (const part of parts) rows.push(...(await pool.query(sql, [part, excluded])).rows);
    return toMap(rows, 'id', 'n');
  };
  const chSums = async (sql, entityType, metricType, ids) => {
    const rows = [];
    for (const part of chunks(ids))
      rows.push(...(await query(sql, { entityType, metricType, ids: part })));
    return toMap(rows, 'entityId', 'total');
  };
  // Postgres, then ClickHouse straight after, for both metrics. The entity count is one full
  // scan (minutes); a bookmark made or removed during it can leave its entity off by one.
  const plan = async ({ entityIds, collectionIds }, prevStampMs) => {
    const entityTruth = await pgCounts(SQL.entityTruth, entityIds, false);
    const collectionTruth = await pgCounts(SQL.collectionTruth, collectionIds, true);
    const entityCh = await chSums(chTotalsSql(EVENTS_TABLE), ENTITY, 'collectedCount', entityIds);
    const collectionCh = await chSums(
      chTotalsSql(EVENTS_TABLE),
      'Collection',
      'itemCount',
      collectionIds
    );
    // Stamped after the reads: the metric jobs only look back a few minutes for affected entities.
    const stampMs = nextStampMs(prevStampMs, Date.now());
    const createdAt = stampMs / 1000;
    const entity = reconcile({
      entityType: ENTITY,
      metricType: 'collectedCount',
      ids: entityIds,
      truth: entityTruth,
      ch: entityCh,
      createdAt,
    });
    const collection = reconcile({
      entityType: 'Collection',
      metricType: 'itemCount',
      ids: collectionIds,
      truth: collectionTruth,
      ch: collectionCh,
      createdAt,
    });
    return { stampMs, entity, collection, events: [...entity.events, ...collection.events] };
  };
  const report = async (result) => {
    for (const [label, part] of [
      [`${ENTITY} collectedCount`, result.entity],
      ['Collection itemCount', result.collection],
    ])
      console.log(`${label}: ${JSON.stringify(deltaSummary(part.rows))}`);
    const samples = result.entity.rows.filter((r) => SAMPLE.has(r.entityId));
    if (!samples.length) return;
    const view = await chSums(
      VIEW_TOTALS_SQL,
      ENTITY,
      'collectedCount',
      samples.map((r) => r.entityId)
    );
    for (const r of samples)
      console.log(
        `  sample ${ENTITY} ${r.entityId}: want ${r.want} have ${r.have} (view now ${
          view.get(r.entityId) ?? 0
        }) delta ${r.delta}`
      );
  };

  if (!EXECUTE) {
    console.log('MODE: dry run, nothing is written.\n');
    let total = 0;
    const skipped = {};
    const entityIds = new Set();
    const collectionIds = new Set();
    for (let lo = FROM ?? 0; lo < to; lo += RANGE) {
      const hi = Math.min(lo + RANGE, to);
      let inRange = 0;
      for (const r of (await pool.query(SQL.candidates, [lo, hi])).rows) {
        if (r.mode !== 'Bookmark') {
          skipped[r.mode ?? 'none'] = (skipped[r.mode ?? 'none'] ?? 0) + r.n;
          continue;
        }
        inRange += r.n;
        entityIds.add(Number(r.entityId));
        collectionIds.add(Number(r.collectionId));
      }
      total += inRange;
      if (inRange) console.log(`[${lo}, ${hi})  ${inRange} rows  running total ${total}`);
    }
    console.log(`\nPhase 1 would give ${total} ${ENTITY} rows an adder.`);
    console.log(
      `Skipped, not in a Bookmark collection, by Collection.mode: ${JSON.stringify(skipped)}`
    );
    console.log(
      `\nPhase 2 would reconcile (want = rows counted after phase 1, have = ClickHouse):`
    );
    await report(
      await plan({ entityIds: [...entityIds], collectionIds: [...collectionIds] }, null)
    );
    await pool.end();
    await ch.close();
    return;
  }

  // Fails now, loudly, if the credential cannot insert, rather than after the first PG commit.
  await ch.command({
    query: `INSERT INTO default.${EVENTS_TABLE} SELECT * FROM default.${EVENTS_TABLE} WHERE 0`,
  });

  const lockClient = await pool.connect();
  const { rows: lockRows } = await lockClient.query(
    'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
    [LOCK_KEY]
  );
  if (!lockRows[0].ok) fail('Error: another run of this backfill holds the lock.');
  // A dropped connection releases the lock silently; stop rather than run unguarded.
  lockClient.on('error', (err) => fail(`Error: lost the lock connection: ${err.message}`));

  const ledgerState = existsSync(LEDGER)
    ? readLedger(readFileSync(LEDGER, 'utf-8').split('\n'), ENTITY)
    : {
        open: null,
        resumeFrom: null,
        touched: { entityIds: [], collectionIds: [] },
        reconcile: null,
        lastStampMs: null,
      };
  const ledger = openLedger(LEDGER);

  const findAtStamp = (stamp) =>
    ch
      .query({
        query: `SELECT entityType, entityId, metricType, userId, metricValue
                FROM default.${EVENTS_TABLE}
                WHERE createdAt = toDateTime({stamp:UInt32}) AND (entityType, metricType) IN (${METRIC_PAIRS.map(
                  ([e, m]) => `('${e}','${m}')`
                ).join(',')})`,
        query_params: { stamp },
        format: 'JSONEachRow',
        clickhouse_settings: { select_sequential_consistency: 1 },
      })
      .then((res) => res.json())
      .then((rows) =>
        rows.map((r) => ({
          ...r,
          entityId: Number(r.entityId),
          userId: Number(r.userId),
          metricValue: Number(r.metricValue),
        }))
      );

  if (ledgerState.reconcile?.phase === 'reconciled')
    fail('This ledger is finished: phase 2 already reconciled. Use a new ledger for a new run.');

  const open = ledgerState.open;
  let start = FROM ?? ledgerState.resumeFrom ?? 0;
  if (open) {
    console.log(`Resuming unfinished batch [${open.lo}, ${open.hi})`);
    const { rows: xact } = await pool.query('SELECT txid_status($1::bigint) AS status', [open.xid]);
    const status = xact[0].status;
    if (status === 'aborted') {
      console.log('  its transaction rolled back; redoing the range');
      ledger.write({ lo: open.lo, phase: 'abandoned' });
      start = FROM ?? open.lo;
    } else if (status === 'committed') {
      ledger.write({ lo: open.lo, phase: 'committed' });
      ledgerState.touched.entityIds.push(...open.entityIds);
      ledgerState.touched.collectionIds.push(...open.collectionIds);
      start = FROM ?? Math.max(open.hi, ledgerState.resumeFrom ?? 0);
      console.log('  it committed');
    } else fail(`Error: transaction ${open.xid} is "${status}". Stopping for a human.`);
  }
  const entityIds = new Set(ledgerState.touched.entityIds);
  const collectionIds = new Set(ledgerState.touched.collectionIds);

  if (!ledgerState.reconcile) {
    console.log(`MODE: EXECUTE. Phase 1, ids [${start}, ${to}) in ranges of ${RANGE}\n`);
    let totalRows = 0;
    for (let lo = start; lo < to; lo += RANGE) {
      const hi = Math.min(lo + RANGE, to);
      const client = await pool.connect();
      let rows;
      try {
        await client.query('BEGIN');
        ({ rows } = await client.query(SQL.update, [lo, hi]));
        if (!rows.length) {
          await client.query('ROLLBACK');
          continue;
        }
        const { rows: txid } = await client.query('SELECT txid_current()::text AS xid');
        ledger.write({
          lo,
          hi,
          phase: 'pending',
          entity: ENTITY,
          xid: txid[0].xid,
          ids: rows.map((r) => r.id),
          entityIds: [...new Set(rows.map((r) => r.entityId))],
          collectionIds: [...new Set(rows.map((r) => r.collectionId))],
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      ledger.write({ lo, phase: 'committed' });
      for (const r of rows) {
        entityIds.add(r.entityId);
        collectionIds.add(r.collectionId);
      }
      totalRows += rows.length;
      console.log(`[${lo}, ${hi})  ${rows.length} rows  total ${totalRows}`);
      await sleep(PAUSE_MS);
    }
    console.log(`\nPhase 1 done: ${totalRows} rows given an adder this run.`);

    console.log(
      `\nPhase 2: reconciling ${entityIds.size} ${ENTITY} and ${collectionIds.size} collections`
    );
    const result = await plan(
      { entityIds: [...entityIds], collectionIds: [...collectionIds] },
      ledgerState.lastStampMs
    );
    const { stampMs } = result;
    await report(result);
    ledger.write({ phase: 'reconcile', entity: ENTITY, stampMs, events: result.events });
    if (result.events.length)
      await ch.insert({ table: EVENTS_TABLE, values: result.events, format: 'JSONEachRow' });
    ledger.write({ phase: 'reconciled' });
    console.log(`\nDone: ${result.events.length} reconcile events inserted at ${stampMs / 1000}.`);
  } else {
    const rec = ledgerState.reconcile;
    console.log(`Resuming phase 2: ${rec.events.length} events planned at ${rec.stampMs / 1000}`);
    const wait = rec.stampMs + LANDING_WAIT_MS - Date.now();
    if (wait > 0) {
      console.log(
        `  waiting ${Math.ceil(wait / 1000)}s for any insert from the crashed run to settle`
      );
      await sleep(wait);
    }
    const found = rec.events.length ? await findAtStamp(rec.stampMs / 1000) : [];
    const state = landedState(rec.events, found);
    if (state === 'partial')
      fail('Error: the reconcile is partly in ClickHouse. Stopping for a human.');
    if (state === 'none') {
      const stampMs = nextStampMs(ledgerState.lastStampMs, Date.now());
      const events = rec.events.map((e) => ({ ...e, createdAt: stampMs / 1000 }));
      ledger.write({ phase: 'restamped', stampMs, events });
      await ch.insert({ table: EVENTS_TABLE, values: events, format: 'JSONEachRow' });
    }
    ledger.write({ phase: 'reconciled' });
    console.log(`  ${state === 'all' ? 'already in ClickHouse' : 'inserted'}`);
  }

  ledger.close();
  lockClient.release();
  await pool.end();
  await ch.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
