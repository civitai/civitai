#!/usr/bin/env node

/**
 * Backfill CollectionItem.addedById on bookmark rows, then have the metric jobs recount
 *
 * Model, Post and Article collectedCount and Collection itemCount are counted from Postgres by
 * the metric jobs (src/server/metrics/collection-item-counts.ts): distinct collectors, ACCEPTED
 * rows only. The jobs recount an entity when it has a CollectionItem event in ClickHouse since
 * their last run. Two gaps keep that from reaching every entity on its own:
 *   - Bookmark rows were written without addedById, and the CDC handler drops events with no
 *     user, so deleting one of them never marks its entity for a recount.
 *   - An entity with no new activity keeps the count it was given under the old rules (a sum of
 *     per-row events, every status, plus a November 2025 bulk seed) until it next changes.
 *
 * Phase 1, per id range: set addedById to the collection owner on null-adder bookmark rows of the
 * entity, one transaction per range. The handler ignores the UPDATE; from then on a delete of one
 * of these rows emits its event as the owner. The jobs already count these rows as the owner, so
 * this changes no count.
 * Phase 2, once phase 1 has covered every id: insert a 0-valued event for every entity and
 * collection the new rules can change. A 0 moves no ClickHouse sum; it only puts the entity in
 * the jobs' next recount. A repeated insert is harmless, so this phase needs no exactly-once.
 *
 * Phase 1 is ledgered: `pending` (txid, ids) -> COMMIT -> `committed`, every line fsynced first.
 * On restart txid_status() of the unfinished batch decides: rolled back is redone, committed is
 * marked so. An advisory lock keeps a second run (another ledger) from touching the same rows.
 *
 * Rollback: set addedById back to NULL on the ledger's ids still present. The touch needs none.
 *
 * Run AFTER the release that counts from Postgres is live (it is what the touch triggers), and
 * after the index migration it reads from.
 *
 * Usage:
 *   node scripts/backfill-collection-item-adder.mjs --entity Article            # dry run
 *   node scripts/backfill-collection-item-adder.mjs --entity Article --execute --ledger ./adder-article.jsonl
 *
 * Env: DATABASE_URL / DATABASE_REPLICA_URL as below, and for --execute CLICKHOUSE_URL or
 * CLICKHOUSE_HOST + CLICKHOUSE_USERNAME + CLICKHOUSE_PASSWORD. Nothing is read from files; a
 * missing one stops the run.
 *
 * Options:
 *   --execute          Write. Needs DATABASE_URL (the primary); the dry run reads
 *                      DATABASE_REPLICA_URL when set, and writes nothing anywhere.
 *   --ledger <path>    Required with --execute. Reuse the same path to resume.
 *   --from <id>        Dry run only: first CollectionItem.id (default 0).
 *   --to <id>          Dry run only: stop before this id (default max(id) + 1). A real run always
 *                      covers every id from where the ledger left off.
 *   --range <n>        Ids per batch (default 20000).
 *   --pause-ms <n>     Pause between batches that wrote something (default 1000).
 *   --touch-pause-ms <n> Pause between phase 2's chunks of 5000 (default 60000), so the jobs
 *                      recount in waves rather than in one run that outlasts their lock.
 *   --entity <type>    Article (default), Model or Post: which bookmarked rows this run repairs.
 *                      A ledger belongs to one entity; the run refuses a ledger from another.
 */

import { createClient } from '@clickhouse/client';
import pg from 'pg';
import { readFileSync, existsSync } from 'fs';
import {
  EVENTS_TABLE,
  backfillSql,
  clickhouseConfig,
  openLedger,
  readLedger,
  touchEvents,
} from './lib/collection-item-adder.mjs';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const EXECUTE = args.includes('--execute');
const LEDGER = arg('--ledger');
const RANGE = Number(arg('--range') ?? 20000);
const PAUSE_MS = Number(arg('--pause-ms') ?? 1000);
const TOUCH_PAUSE_MS = Number(arg('--touch-pause-ms') ?? 60000);
const FROM = arg('--from') != null ? Number(arg('--from')) : null;
const TO = arg('--to') != null ? Number(arg('--to')) : null;
const ENTITY = arg('--entity') ?? 'Article';

const SQL = backfillSql(ENTITY);

const LOCK_KEY = 'backfill-collection-item-adder';
const TOUCH_CHUNK = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const pgUrl = EXECUTE
    ? process.env.DATABASE_URL
    : process.env.DATABASE_REPLICA_URL ?? process.env.DATABASE_URL;
  if (!pgUrl)
    fail(
      EXECUTE
        ? 'Error: DATABASE_URL (the primary) is required with --execute.'
        : 'Error: set DATABASE_REPLICA_URL (or DATABASE_URL) for the dry run.'
    );

  const pool = new pg.Pool({ connectionString: pgUrl, connectionTimeoutMillis: 30000, max: 3 });
  const { rows: maxRows } = await pool.query('SELECT max(id) AS max FROM "CollectionItem"');
  const to = TO ?? Number(maxRows[0].max ?? 0) + 1;
  const touchIds = async () => ({
    entities: (await pool.query(SQL.touchEntities)).rows.map((r) => Number(r.id)),
    collections: (await pool.query(SQL.touchCollections)).rows.map((r) => Number(r.id)),
  });

  if (!EXECUTE) {
    console.log('MODE: dry run, nothing is written.\n');
    let total = 0;
    const skipped = {};
    for (let lo = FROM ?? 0; lo < to; lo += RANGE) {
      const hi = Math.min(lo + RANGE, to);
      for (const { mode, n } of (await pool.query(SQL.candidates, [lo, hi])).rows) {
        if (mode === 'Bookmark') {
          total += n;
          console.log(`[${lo}, ${hi})  ${n} rows  running total ${total}`);
        } else skipped[mode ?? 'none'] = (skipped[mode ?? 'none'] ?? 0) + n;
      }
    }
    console.log(`\nPhase 1 would give ${total} ${ENTITY} rows an adder.`);
    console.log(
      `Skipped, not in a Bookmark collection, by Collection.mode: ${JSON.stringify(skipped)}`
    );
    const ids = await touchIds();
    console.log(
      `Phase 2 would mark ${ids.entities.length} ${ENTITY} and ${ids.collections.length} collections for a recount.`
    );
    await pool.end();
    return;
  }

  let chConfig;
  try {
    chConfig = clickhouseConfig(process.env);
  } catch (err) {
    fail(`Error: ${err.message}`);
  }
  const ch = createClient({ ...chConfig, request_timeout: 300000 });
  // Fails now, loudly, if the credential cannot insert, rather than after phase 1.
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
    : { open: null, resumeFrom: null, touched: false };
  if (ledgerState.touched)
    fail('This ledger is finished: the touch already ran. Use a new ledger for a new run.');
  const ledger = openLedger(LEDGER);

  const open = ledgerState.open;
  let start = ledgerState.resumeFrom ?? 0;
  if (open) {
    console.log(`Resuming unfinished batch [${open.lo}, ${open.hi})`);
    const { rows: xact } = await pool.query('SELECT txid_status($1::bigint) AS status', [open.xid]);
    const status = xact[0].status;
    if (status === 'aborted') {
      console.log('  its transaction rolled back; redoing the range');
      ledger.write({ lo: open.lo, phase: 'abandoned' });
      start = open.lo;
    } else if (status === 'committed') {
      ledger.write({ lo: open.lo, phase: 'committed' });
      start = Math.max(open.hi, start);
      console.log('  it committed');
    } else fail(`Error: transaction ${open.xid} is "${status}". Stopping for a human.`);
  }

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
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    ledger.write({ lo, phase: 'committed' });
    totalRows += rows.length;
    console.log(`[${lo}, ${hi})  ${rows.length} rows  total ${totalRows}`);
    await sleep(PAUSE_MS);
  }
  console.log(`\nPhase 1 done: ${totalRows} rows given an adder this run.`);

  const ids = await touchIds();
  const batches = [
    ...chunkIds(ids.entities).map((part) => [ENTITY, 'collectedCount', part]),
    ...chunkIds(ids.collections).map((part) => ['Collection', 'itemCount', part]),
  ];
  console.log(
    `\nPhase 2: marking ${ids.entities.length} ${ENTITY} and ${ids.collections.length} collections`
  );
  for (const [entityType, metricType, part] of batches) {
    // Stamped at insert: the jobs only look back a few minutes for affected entities.
    const events = touchEvents(entityType, metricType, part, Math.floor(Date.now() / 1000));
    await ch.insert({ table: EVENTS_TABLE, values: events, format: 'JSONEachRow' });
    console.log(`  ${entityType} ${metricType}: ${part.length}`);
    await sleep(TOUCH_PAUSE_MS);
  }
  ledger.write({ phase: 'touched', entity: ENTITY });
  console.log('\nDone.');

  ledger.close();
  lockClient.release();
  await pool.end();
  await ch.close();
}

function chunkIds(list) {
  return Array.from({ length: Math.ceil(list.length / TOUCH_CHUNK) }, (_, i) =>
    list.slice(i * TOUCH_CHUNK, (i + 1) * TOUCH_CHUNK)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
