#!/usr/bin/env node

/**
 * Backfill CollectionItem.addedById, and the collection metric events it should have produced
 *
 * Bookmark rows used to be written with no addedById. collectionItemHandler attributes every
 * event to addedById and drops events with no user, so those bookmarks never counted toward
 * Model/Article/Post collectedCount or Collection itemCount, all of which are sums of ClickHouse
 * events. Their deletes are dropped the same way, so the counts are short by exactly the rows
 * still present with no adder.
 *
 * For each id range this sets addedById to the collection owner and inserts one +1 per row into
 * the events table (default entityMetricEvents_month) as that owner, mirroring the handler. Both halves are needed: once
 * addedById is set, a later delete emits -1 through CDC, so a row given an adder but no +1 would
 * push its counts below the truth. The UPDATE itself emits nothing (the handler only reads creates
 * and deletes). Image rows are out of scope and keep a null adder.
 *
 * Exactly-once, because a duplicate insert is not harmless here: entityMetricSum_v3 consumes each
 * insert before ReplacingMergeTree dedups it, so a retried insert counts twice. Per batch:
 *   UPDATE ... RETURNING (in a transaction) -> ledger `pending` line with the rows, events and
 *   stamp, fsynced -> COMMIT -> ledger `committed` -> ClickHouse insert -> ledger `inserted`.
 * On restart the one unfinished batch is checked, not retried. Whether it committed is
 * txid_status() of the transaction id in its pending line, so rows deleted since cannot make it
 * read as uncommitted. Whether it landed is a sequentially consistent read for its exact events at
 * its stamp, taken only once the stamp is LANDING_WAIT_MS old so an insert still in flight has
 * finished or failed. Not landed: it is re-stamped to now and inserted, because a stale stamp
 * would miss the daily views and the metric jobs. A partial match stops the run for a human.
 * An advisory lock keeps a second run (another ledger) from touching the same rows.
 *
 * Events are one per (entityType, entityId, metricType, userId) per batch, valued at the row
 * count, and each batch has its own createdAt second, never in the past. A real event for the same
 * user and entity in the same second shares the raw table's key; the running sum still counts
 * both, and only the raw row is collapsed. Accepted.
 *
 * Run AFTER the release that sets addedById on new bookmarks is live, or rows created behind the
 * run stay uncounted.
 *
 * Usage:
 *   node scripts/backfill-collection-item-adder.mjs                     # dry run: counts per range
 *   node scripts/backfill-collection-item-adder.mjs --execute --ledger ./adder-ledger.jsonl
 *
 * Options:
 *   --execute          Write. Needs DATABASE_URL (the primary); the dry run reads
 *                      DATABASE_REPLICA_URL when set.
 *   --ledger <path>    Required with --execute. Reuse the same path to resume.
 *   --from <id>        First CollectionItem.id (default 0, or where the ledger left off).
 *   --to <id>          Stop before this id (default max(id) + 1).
 *   --range <n>        Ids per batch (default 20000).
 *   --pause-ms <n>     Pause between batches that wrote something (default 1000).
 *   --entity <type>    Article (default), Model or Post: which bookmarked rows this run repairs.
 *                      A ledger belongs to one entity; the run refuses a ledger from another.
 *   --events-table <t> Raw events table (default entityMetricEvents_month). The run refuses a
 *                      table that does not feed entityMetricSum_v3.
 */

import { createClient } from '@clickhouse/client';
import pg from 'pg';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  METRIC_PAIRS,
  buildEvents,
  landedState,
  entityScope,
  nextStampMs,
  openLedger,
  readLedger,
} from './lib/collection-item-adder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
  }
  return out;
}

const chEnv = loadEnvFile(resolve(__dirname, '../.claude/skills/clickhouse-query/.env'));
const pgEnv = loadEnvFile(resolve(__dirname, '../.claude/skills/postgres-query/.env'));

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const EXECUTE = args.includes('--execute');
const LEDGER = arg('--ledger');
const RANGE = Number(arg('--range') ?? 20000);
const PAUSE_MS = Number(arg('--pause-ms') ?? 1000);
const FROM = arg('--from') != null ? Number(arg('--from')) : null;
const TO = arg('--to') != null ? Number(arg('--to')) : null;
const ENTITY = arg('--entity') ?? 'Article';

const SCOPE = `
  ci."collectionId" = c.id
  AND ci.id >= $1 AND ci.id < $2
  AND ci."addedById" IS NULL
  AND ci."imageId" IS NULL
  AND ${entityScope(ENTITY)}
  AND c."userId" > 0`;

const COUNT_SQL = `SELECT count(*)::int AS n FROM "CollectionItem" ci, "Collection" c WHERE ${SCOPE}`;

const UPDATE_SQL = `
  UPDATE "CollectionItem" ci SET "addedById" = c."userId"
  FROM "Collection" c
  WHERE ${SCOPE}
  RETURNING ci.id, ci."collectionId", ci."articleId", ci."modelId", ci."postId", ci."addedById"`;

// Longer than the client's request_timeout, so an insert from the crashed run is settled.
const LANDING_WAIT_MS = 15 * 60 * 1000;
const EVENTS_TABLE = arg('--events-table') ?? 'entityMetricEvents_month';
const LOCK_KEY = 'backfill-collection-item-adder';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(...lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

async function main() {
  if (!Number.isInteger(RANGE) || RANGE <= 0) fail(`Error: --range must be a positive integer`);
  if (EXECUTE && !LEDGER)
    fail('Error: --execute needs --ledger <path>; it is what makes a rerun safe.');

  const pgUrl = EXECUTE
    ? process.env.DATABASE_URL
    : process.env.DATABASE_REPLICA_URL ?? pgEnv.DATABASE_REPLICA_URL ?? process.env.DATABASE_URL;
  if (!pgUrl)
    fail(
      EXECUTE
        ? 'Error: DATABASE_URL (the primary) is required with --execute.'
        : 'Error: set DATABASE_REPLICA_URL (or DATABASE_URL) for the dry run.'
    );

  const chUrl = process.env.CLICKHOUSE_URL ?? chEnv.CLICKHOUSE_URL;
  const ch = createClient(
    chUrl
      ? { url: chUrl, request_timeout: 300000 }
      : {
          url: process.env.CLICKHOUSE_HOST ?? chEnv.CLICKHOUSE_HOST,
          username:
            process.env.CLICKHOUSE_USERNAME ??
            process.env.CLICKHOUSE_USER ??
            chEnv.CLICKHOUSE_USERNAME ??
            chEnv.CLICKHOUSE_USER,
          password: process.env.CLICKHOUSE_PASSWORD ?? chEnv.CLICKHOUSE_PASSWORD,
          request_timeout: 300000,
        }
  );
  const query = async (sql, params) =>
    (await ch.query({ query: sql, query_params: params, format: 'JSONEachRow' })).json();

  // An unregistered or non-additive pair is totalled as distinct users, not as a sum, and every
  // row-count event written here would read as one.
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

  const pool = new pg.Pool({ connectionString: pgUrl, connectionTimeoutMillis: 30000, max: 3 });
  const { rows: maxRows } = await pool.query('SELECT max(id) AS max FROM "CollectionItem"');
  const to = TO ?? Number(maxRows[0].max ?? 0) + 1;

  if (!EXECUTE) {
    console.log('MODE: dry run, nothing is written.\n');
    let total = 0;
    for (let lo = FROM ?? 0; lo < to; lo += RANGE) {
      const hi = Math.min(lo + RANGE, to);
      const { rows } = await pool.query(COUNT_SQL, [lo, hi]);
      total += rows[0].n;
      if (rows[0].n) console.log(`[${lo}, ${hi})  ${rows[0].n} rows  running total ${total}`);
    }
    console.log(`\nDry run complete: ${total} rows would get an adder and a +1.`);
    await pool.end();
    await ch.close();
    return;
  }

  if (!/^\w+$/.test(EVENTS_TABLE))
    fail(`Error: --events-table "${EVENTS_TABLE}" is not a table name`);
  // Events written to a table nothing sums would set adders with no +1, and every later delete
  // would then push a count below the truth.
  const feeds = await query(
    `SELECT name FROM system.tables
     WHERE database = 'default' AND engine = 'MaterializedView'
       AND position(create_table_query, 'entityMetricSum_v3') > 0
       AND match(create_table_query, {re:String})`,
    { re: `FROM\\s+(default\\.)?\`?${EVENTS_TABLE}\`?(\\s|$)` }
  );
  if (!feeds.length)
    fail(`Error: no materialized view feeds entityMetricSum_v3 from ${EVENTS_TABLE}. Wrong table?`);

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
    : { open: null, resumeFrom: null, lastStampMs: null };
  const ledger = openLedger(LEDGER);
  let lastStampMs = ledgerState.lastStampMs;

  const insertEvents = (events) =>
    ch.insert({ table: EVENTS_TABLE, values: events, format: 'JSONEachRow' });

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

  const open = ledgerState.open;
  if (open) {
    console.log(`Resuming unfinished batch [${open.lo}, ${open.hi}) at phase ${open.phase}`);
    const { rows: xact } = await pool.query('SELECT txid_status($1::bigint) AS status', [open.xid]);
    const status = xact[0].status;
    if (status === 'aborted') {
      console.log('  its transaction rolled back; redoing the range');
      ledger.write({ lo: open.lo, phase: 'abandoned' });
    } else if (status !== 'committed') {
      fail(`Error: transaction ${open.xid} is "${status}". Stopping for a human.`);
    } else {
      const wait = open.stampMs + LANDING_WAIT_MS - Date.now();
      if (wait > 0) {
        console.log(
          `  waiting ${Math.ceil(wait / 1000)}s for any insert from the crashed run to settle`
        );
        await sleep(wait);
      }
      const state = landedState(open.events, await findAtStamp(open.events[0].createdAt));
      if (state === 'partial')
        fail(
          `Error: batch [${open.lo}, ${open.hi}) is partly in ClickHouse. Stopping for a human.`
        );
      if (state === 'none') {
        const stampMs = nextStampMs(lastStampMs, Date.now());
        const events = open.events.map((e) => ({ ...e, createdAt: stampMs / 1000 }));
        ledger.write({ lo: open.lo, phase: 'restamped', stampMs, events });
        lastStampMs = stampMs;
        await insertEvents(events);
      }
      ledger.write({ lo: open.lo, phase: 'inserted' });
      console.log(`  ${state === 'all' ? 'already in ClickHouse' : 'inserted'}`);
    }
  }

  // The open batch's range is redone either way: the UPDATE only matches rows still without an adder.
  const start = FROM ?? open?.lo ?? ledgerState.resumeFrom ?? 0;
  console.log(`MODE: EXECUTE. ids [${start}, ${to}) in ranges of ${RANGE}\n`);

  let totalRows = 0;
  let totalEvents = 0;
  for (let lo = start; lo < to; lo += RANGE) {
    const hi = Math.min(lo + RANGE, to);
    const client = await pool.connect();
    let rows;
    let events;
    let stampMs;
    try {
      await client.query('BEGIN');
      ({ rows } = await client.query(UPDATE_SQL, [lo, hi]));
      if (!rows.length) {
        await client.query('ROLLBACK');
        continue;
      }
      stampMs = nextStampMs(lastStampMs, Date.now());
      // Epoch seconds: a DateTime string would be read in the server's timezone.
      events = buildEvents(rows, stampMs / 1000);
      const { rows: txid } = await client.query('SELECT txid_current()::text AS xid');
      ledger.write({ lo, hi, phase: 'pending', entity: ENTITY, xid: txid[0].xid, stampMs, events });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    lastStampMs = stampMs;
    ledger.write({ lo, phase: 'committed' });
    await insertEvents(events);
    ledger.write({ lo, phase: 'inserted' });

    totalRows += rows.length;
    totalEvents += events.length;
    console.log(
      `[${lo}, ${hi})  ${rows.length} rows  ${events.length} events  totals ${totalRows} / ${totalEvents}`
    );
    await sleep(PAUSE_MS);
  }

  console.log(`\nDone: ${totalRows} rows given an adder, ${totalEvents} events inserted.`);
  ledger.close();
  lockClient.release();
  await pool.end();
  await ch.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
