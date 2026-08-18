#!/usr/bin/env node

/**
 * Backfill User.commentCount from Postgres
 *
 * Postgres is the source of truth up to the moment the forward path started emitting, and the
 * forward path started at a DIFFERENT moment for each group of surfaces:
 *   - Post / Image / Article / Bounty  -> event-engine v1.9.13 (#4002)
 *   - every other surface              -> the release carrying #4067
 * Backfilling both to one boundary either double-counts the first group or loses everything the
 * second group received between the run and its own release.
 *
 * Totals are read from daily aggregates, not from the event stream: entityMetricDaily_today_v2_mv
 * and entityMetricDailySeal_v2_mv both filter `createdAt >= today() - 1`, so historically-dated
 * rows written into entityMetricEvents_month would be invisible to every total. The backfill
 * therefore writes day totals into entityMetricDailyAgg_history_v2 and marks each entity dirty so
 * entityMetricTotal_v3_refresher_additive recomputes it.
 *
 * That table is a ReplacingMergeTree versioned by `sealedAt`, keyed
 * (entityType, entityId, metricType, day), and history rows carry NO surface dimension. A written
 * row REPLACES that day for that user rather than adding to it. Every day from the first live
 * event onward already holds sealed live totals for the four old surfaces, so writing a
 * new-surface-only total over it would destroy both halves. All such days are excluded here and
 * need an explicit merge (backfill total + sealed total, written with a fresh sealedAt).
 *
 * This is only readable while ('User','commentCount') is registered `additive` in
 * entityMetricKind, which the script asserts before writing. Flip that row and the presence-based
 * refresher recomputes the total from entityMetricUserState_v3 — which holds only live events —
 * and silently overwrites every backfilled total with a much smaller number.
 *
 * Known and accepted divergences from the live path, both small: a comment created before the
 * cutover and deleted during the run is subtracted twice; and two comments from the same commenter
 * to the same owner in the same second collapse to one live (ReplacingMergeTree key) but count as
 * two here.
 *
 * Usage:
 *   node scripts/backfill-user-comment-count.mjs --new-cutover 2026-08-18T12:00:00Z
 *   node scripts/backfill-user-comment-count.mjs --new-cutover ... --execute
 *
 * Options:
 *   --new-cutover <iso>  When the release carrying #4067 went live. Required, must be in the past.
 *   --execute            Actually write. Default is a dry run that writes nothing.
 *   --no-dirty           Write history, flag nothing. History rows are invisible to every total
 *                        until their entity is dirtied, so this is a full-scale, fully reversible
 *                        rehearsal: verify sampled owners against Postgres, then run --dirty-only.
 *   --dirty-only         Flag the owners, write no history. The second half of that pair.
 *   --limit <n>          Write only the first n day rows. Smoke test only: it marks those owners
 *                        dirty too, so their live totals go WRONG until a full run lands. Prefer
 *                        --no-dirty, which is wrong for nobody.
 */

import { createClient } from '@clickhouse/client';
import pg from 'pg';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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
const EXECUTE = args.includes('--execute');
const NO_DIRTY = args.includes('--no-dirty');
const DIRTY_ONLY = args.includes('--dirty-only');
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : null;
const NEW_CUTOVER = args.includes('--new-cutover') ? args[args.indexOf('--new-cutover') + 1] : null;

// Rows per dirty-flag batch, and the pause between batches. The refresher's window is a ROLLING ten
// minutes, so every row sits in it for ten minutes whenever it arrives and the total re-reads are
// the same either way — chunking caps the OCCUPANCY, and only if the rate stays under
// target/10min. At 2,500/min the extra occupancy tops out around 25k, roughly one baseline against
// the platform's normal 2,500-3,000/min. Faster than that (5,000 per 30s parks ~100k in the window)
// is the un-chunked flood arriving ten minutes late. ~42 minutes for 104k owners.
const DIRTY_CHUNK = 2500;
const DIRTY_PAUSE_MS = 60000;

const OLD_SURFACES = new Set(['post', 'image', 'article', 'bounty']);

const SURFACES = [
  { key: 'post', fk: 'postId', table: '"Post"', owner: 'e."userId"' },
  { key: 'image', fk: 'imageId', table: '"Image"', owner: 'e."userId"' },
  { key: 'article', fk: 'articleId', table: '"Article"', owner: 'e."userId"' },
  { key: 'bounty', fk: 'bountyId', table: '"Bounty"', owner: 'e."userId"' },
  { key: 'review', fk: 'reviewId', table: '"ResourceReview"', owner: 'e."userId"' },
  { key: 'bountyEntry', fk: 'bountyEntryId', table: '"BountyEntry"', owner: 'e."userId"' },
  { key: 'challenge', fk: 'challengeId', table: '"Challenge"', owner: 'e."createdById"' },
  { key: 'comic', fk: 'comicProjectId', table: '"ComicProject"', owner: 'e."userId"' },
  { key: 'clubPost', fk: 'clubPostId', table: '"ClubPost"', owner: 'e."createdById"' },
  { key: 'model3d', fk: 'model3dId', table: '"Model3D"', owner: 'e."userId"' },
  { key: 'model3dReview', fk: 'model3dReviewId', table: '"Model3DReview"', owner: 'e."userId"' },
  { key: 'modelV2', fk: 'modelId', table: '"Model"', owner: 'e."userId"' },
  { key: 'question', fk: 'questionId', table: '"Question"', owner: 'e."userId"' },
  { key: 'answer', fk: 'answerId', table: '"Answer"', owner: 'e."userId"' },
  {
    key: 'appListing',
    fk: 'appListingId',
    table: 'app_listings',
    owner: 'e.user_id',
    idCol: 'e.serial_id',
  },
];

// `createdAt` is `timestamp without time zone` holding UTC. node-pg serialises a JS Date with the
// HOST's offset and Postgres then drops that offset, so binding a Date silently moves the boundary
// by the host's timezone — measured at 847 comments through a 6 hour shift, each of them skipped by
// the backfill and never emitted by the forward path. Bind the wall-clock UTC string instead.
const asUtcTimestamp = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

// `day` comes back as a string from `to_char`: a DATE would be parsed into a LOCAL-midnight Date,
// and `toISOString()` on that shifts the day on any UTC+ host. A day shifted onto today or
// yesterday is dropped from every total, because entityMetricDailyAgg_v2_prev reads history only
// for `day < today() - 1`.
function commentV2Sql(surface) {
  return `
    SELECT owner AS "ownerId", day, count(*)::int AS total
    FROM (
      SELECT ${surface.owner} AS owner,
             to_char(c."createdAt", 'YYYY-MM-DD') AS day,
             c."userId" AS commenter
      FROM "CommentV2" c
      JOIN "Thread" t ON t.id = c."threadId"
      LEFT JOIN "Thread" r ON r.id = t."rootThreadId"
      JOIN ${surface.table} e ON ${surface.idCol ?? 'e.id'} = COALESCE(r."${surface.fk}", t."${surface.fk}")
      WHERE c."createdAt" < $1::timestamp AND c."userId" <> ALL($2::int[])
    ) s
    WHERE owner IS NOT NULL AND owner <> commenter
    GROUP BY 1, 2`;
}

const LEGACY_MODEL_SQL = `
  SELECT m."userId" AS "ownerId",
         to_char(c."createdAt", 'YYYY-MM-DD') AS day,
         count(*)::int AS total
  FROM "Comment" c
  JOIN "Model" m ON m.id = c."modelId"
  WHERE c."createdAt" < $1::timestamp
    AND c."userId" <> ALL($2::int[])
    AND m."userId" <> c."userId"
  GROUP BY 1, 2`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function daysBetween(fromDay, toDay) {
  const days = [];
  for (let d = new Date(`${fromDay}T00:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    days.push(day);
    if (day >= toDay) break;
  }
  return days;
}

async function main() {
  if (!NEW_CUTOVER) {
    console.error('Error: --new-cutover <iso> is required. It is when the release carrying #4067');
    console.error('went live. Without it the new surfaces get an arbitrary boundary and every');
    console.error('comment between that boundary and the release is lost.');
    process.exit(1);
  }
  const newCutover = new Date(NEW_CUTOVER);
  if (Number.isNaN(newCutover.getTime())) {
    console.error(`Error: --new-cutover "${NEW_CUTOVER}" is not a date`);
    process.exit(1);
  }
  if (newCutover > new Date()) {
    console.error(`Error: --new-cutover ${newCutover.toISOString()} is in the future. Run this`);
    console.error('AFTER the release: comments created between the boundary and the real release');
    console.error('are counted by neither path.');
    process.exit(1);
  }

  const replicaUrl = process.env.DATABASE_REPLICA_URL ?? pgEnv.DATABASE_REPLICA_URL;
  if (!replicaUrl) {
    console.error('Error: DATABASE_REPLICA_URL is required. This is 16 sequential full scans of');
    console.error('CommentV2 driving ~34M index probes; it does not belong on the primary, so');
    console.error('there is deliberately no fallback to DATABASE_URL.');
    process.exit(1);
  }

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

  const query = async (sql) => (await ch.query({ query: sql, format: 'JSONEachRow' })).json();

  const kind = await query(`SELECT kind FROM default.entityMetricKind FINAL
                            WHERE entityType = 'User' AND metricType = 'commentCount'`);
  if (kind[0]?.kind !== 'additive') {
    console.error(`Error: entityMetricKind for User/commentCount is "${kind[0]?.kind ?? 'missing'}",`);
    console.error('not "additive". Day totals are only readable through the additive refresher;');
    console.error('under any other kind the total is recomputed from live events alone and every');
    console.error('backfilled value is silently replaced by a much smaller one.');
    process.exit(1);
  }

  if (EXECUTE) {
    // Writes nothing, but fails now rather than after ~20 minutes of Postgres scans if the
    // credential turns out to be read-only.
    await ch.command({
      query: `INSERT INTO default.entityMetricDailyAgg_history_v2
              SELECT * FROM default.entityMetricDailyAgg_history_v2 WHERE 0`,
    });
  }

  const firstEventRows = await query(`SELECT min(createdAt) AS firstEvent, count() AS events
                                      FROM default.entityMetricEvents_month
                                      WHERE entityType = 'User' AND metricType = 'commentCount'`);
  const firstEvent =
    Number(firstEventRows[0]?.events ?? 0) > 0
      ? // ClickHouse returns `YYYY-MM-DD HH:MM:SS` with no zone. Parsed as-is that is a LOCAL time,
        // which would move the boundary by the host's offset — the same bug as binding a Date.
        new Date(`${firstEventRows[0].firstEvent.replace(' ', 'T')}Z`)
      : null;

  if (!firstEvent) {
    console.error('Error: no User.commentCount events in ClickHouse. The forward path is not live,');
    console.error('so there is no boundary to back off from and nothing to backfill up to.');
    process.exit(1);
  }
  if (newCutover < firstEvent) {
    console.error(`Error: --new-cutover ${newCutover.toISOString()} is before the first live event`);
    console.error(`(${firstEvent.toISOString()}). One of the two is wrong; refusing to guess.`);
    process.exit(1);
  }

  const excluded = await query(`SELECT userId FROM default.metricExcludedUsers FINAL
                                WHERE active = 1`);
  const excludedIds = excluded.map((row) => Number(row.userId));

  console.log(`ClickHouse first User.commentCount event: ${firstEvent.toISOString()}`);
  console.log(`  boundary for post/image/article/bounty: ${firstEvent.toISOString()}`);
  console.log(`  boundary for every other surface:       ${newCutover.toISOString()}`);
  console.log(`  excluded commenters (metricExcludedUsers): ${excludedIds.length}`);
  console.log(EXECUTE ? '\nMODE: EXECUTE, this will write.\n' : '\nMODE: dry run, nothing is written.\n');

  const pool = new pg.Pool({ connectionString: replicaUrl, connectionTimeoutMillis: 30000, max: 4 });

  const byOwner = new Map();
  let grandTotal = 0;

  const add = (ownerId, day, total) => {
    if (!byOwner.has(ownerId)) byOwner.set(ownerId, new Map());
    const days = byOwner.get(ownerId);
    days.set(day, (days.get(day) ?? 0) + total);
    grandTotal += total;
  };

  const report = (label, rows, started) => {
    const total = rows.reduce((sum, row) => sum + row.total, 0);
    console.log(
      `${label.padEnd(14)} ${String(total).padStart(9)} comments  ${String(rows.length).padStart(7)} owner-days  ${Date.now() - started}ms`
    );
  };

  for (const surface of SURFACES) {
    const boundary = OLD_SURFACES.has(surface.key) ? firstEvent : newCutover;
    const started = Date.now();
    const { rows } = await pool.query(commentV2Sql(surface), [
      asUtcTimestamp(boundary),
      excludedIds,
    ]);
    for (const row of rows) add(row.ownerId, row.day, row.total);
    report(surface.key, rows, started);
  }

  {
    const started = Date.now();
    const { rows } = await pool.query(LEGACY_MODEL_SQL, [asUtcTimestamp(newCutover), excludedIds]);
    for (const row of rows) add(row.ownerId, row.day, row.total);
    report('model (legacy)', rows, started);
  }

  await pool.end();

  const rowsToWrite = [];
  for (const [ownerId, days] of byOwner) {
    for (const [day, total] of days) {
      rowsToWrite.push({
        entityType: 'User',
        entityId: ownerId,
        metricType: 'commentCount',
        day,
        total,
      });
    }
  }

  console.log(`\n${grandTotal} comments across ${byOwner.size} owners -> ${rowsToWrite.length} day rows`);

  // Every day from the first live event onward already carries sealed totals for the four old
  // surfaces, and a history row has no surface dimension — so writing a new-surface-only total over
  // one of those days destroys the live half AND the old-surface half in a single stroke. It is not
  // just the two endpoint days: the whole span between them is live for four surfaces and
  // backfilled for twelve, and it grows by a day for every day the release slips.
  const mergeDays = new Set(
    daysBetween(firstEvent.toISOString().slice(0, 10), newCutover.toISOString().slice(0, 10))
  );
  const needsMerge = rowsToWrite.filter((row) => mergeDays.has(row.day));
  const safeRows = rowsToWrite.filter((row) => !mergeDays.has(row.day));
  if (needsMerge.length) {
    const mergeTotal = needsMerge.reduce((sum, row) => sum + row.total, 0);
    console.log(
      `\n${needsMerge.length} rows fall on a day that already holds live totals ` +
        `(${[...mergeDays].join(', ')}), carrying ${mergeTotal} comments. Writing them would ` +
        `REPLACE the sealed live value rather than add to it, so they are excluded. They need an ` +
        `explicit merge: backfill total + existing sealed total, written with a fresh sealedAt.`
    );
  }

  const top = [...byOwner.entries()]
    .map(([ownerId, days]) => [ownerId, [...days.values()].reduce((a, b) => a + b, 0)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  console.log('\nTop owners by backfilled comments:');
  for (const [ownerId, total] of top) console.log(`  ${String(ownerId).padStart(10)}  ${total}`);

  if (!EXECUTE) {
    console.log(`\nDry run complete. ${safeRows.length} rows would be written to`);
    console.log('entityMetricDailyAgg_history_v2, then one entityMetricDirty_v3 row per owner');
    console.log(`(${byOwner.size}) in chunks of ${DIRTY_CHUNK} every ${DIRTY_PAUSE_MS / 1000}s.`);
    console.log('\nSample:');
    for (const row of safeRows.slice(0, 5)) console.log(' ', JSON.stringify(row));
    await ch.close();
    return;
  }

  const limited = LIMIT ? safeRows.slice(0, LIMIT) : safeRows;
  const BATCH = 50000;
  if (DIRTY_ONLY) {
    console.log('--dirty-only: skipping the history write');
  } else {
    for (let i = 0; i < limited.length; i += BATCH) {
      await ch.insert({
        table: 'entityMetricDailyAgg_history_v2',
        values: limited.slice(i, i + BATCH),
        format: 'JSONEachRow',
      });
      console.log(`wrote ${Math.min(i + BATCH, limited.length)}/${limited.length} day rows`);
    }
  }

  if (NO_DIRTY) {
    console.log('--no-dirty: history written, nothing flagged. No total moves until --dirty-only.');
    await ch.close();
    return;
  }

  const dirty = [...new Set(limited.map((row) => row.entityId))].map((entityId) => ({
    entityType: 'User',
    entityId,
    metricType: 'commentCount',
  }));
  for (let i = 0; i < dirty.length; i += DIRTY_CHUNK) {
    if (i > 0) await sleep(DIRTY_PAUSE_MS);
    await ch.insert({
      table: 'entityMetricDirty_v3',
      values: dirty.slice(i, i + DIRTY_CHUNK),
      format: 'JSONEachRow',
    });
    console.log(`marked ${Math.min(i + DIRTY_CHUNK, dirty.length)}/${dirty.length} owners dirty`);
  }

  await ch.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
