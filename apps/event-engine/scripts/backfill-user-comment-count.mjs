#!/usr/bin/env node

/**
 * Backfill User.commentCount from Postgres
 *
 * Postgres is the source of truth up to the moment the forward path started emitting, and the
 * forward path started at a DIFFERENT moment for each group of surfaces:
 *   - Post / Image / Article / Bounty  -> event-engine v1.9.13 (#4002)
 *   - every other surface              -> the release carrying #4067
 * Backfilling both to one boundary either double-counts the first group or loses everything the
 * second group received between the run and its own release. Both boundaries are required.
 *
 * Totals are read from daily aggregates, not from the event stream: entityMetricDaily_today_v2_mv
 * only ever looks at `createdAt >= today() - 1`, so historically-dated rows written into
 * entityMetricEvents_month would be invisible to every total. The backfill therefore writes day
 * totals into entityMetricDailyAgg_history_v2 and marks each entity dirty so the additive
 * refresher recomputes it.
 *
 * That table is a ReplacingMergeTree versioned by `sealedAt`, keyed
 * (entityType, entityId, metricType, day) — a written row REPLACES that day rather than adding to
 * it. Days that already carry live events are therefore reported, not written.
 *
 * Usage:
 *   node scripts/backfill-user-comment-count.mjs --new-cutover 2026-08-18T12:00:00Z
 *   node scripts/backfill-user-comment-count.mjs --new-cutover ... --execute
 *
 * Options:
 *   --new-cutover <iso>  When the release carrying #4067 went live. Required.
 *   --execute            Actually write. Default is a dry run that writes nothing.
 *   --limit <n>          Only write the first n day rows (smoke test).
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
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : null;
const NEW_CUTOVER = args.includes('--new-cutover') ? args[args.indexOf('--new-cutover') + 1] : null;

// The four surfaces already emitting since #4002. Their boundary is read from ClickHouse rather
// than hardcoded: comments after the first live event are already counted, and the run is only
// safe if that is the real first event rather than the one a ticket recorded.
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

function commentV2Sql(surface) {
  return `
    SELECT owner AS "ownerId", day, count(*)::int AS total
    FROM (
      SELECT ${surface.owner} AS owner,
             (c."createdAt" AT TIME ZONE 'UTC')::date AS day,
             c."userId" AS commenter
      FROM "CommentV2" c
      JOIN "Thread" t ON t.id = c."threadId"
      LEFT JOIN "Thread" r ON r.id = t."rootThreadId"
      JOIN ${surface.table} e ON ${surface.idCol ?? 'e.id'} = COALESCE(r."${surface.fk}", t."${surface.fk}")
      WHERE c."createdAt" < $1
    ) s
    WHERE owner IS NOT NULL AND owner <> commenter
    GROUP BY 1, 2`;
}

const LEGACY_MODEL_SQL = `
  SELECT m."userId" AS "ownerId",
         (c."createdAt" AT TIME ZONE 'UTC')::date AS day,
         count(*)::int AS total
  FROM "Comment" c
  JOIN "Model" m ON m.id = c."modelId"
  WHERE c."createdAt" < $1 AND m."userId" <> c."userId"
  GROUP BY 1, 2`;

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

  // The app is configured with a single credentialed CLICKHOUSE_URL; the query skill splits it into
  // host/username/password. Either is accepted so this runs both in a pod and from a workstation.
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

  const firstEventRows = await (
    await ch.query({
      query: `SELECT min(createdAt) AS firstEvent, count() AS events
              FROM default.entityMetricEvents_month
              WHERE entityType = 'User' AND metricType = 'commentCount'`,
      format: 'JSONEachRow',
    })
  ).json();
  const hasEvents = Number(firstEventRows[0]?.events ?? 0) > 0;
  const firstEvent = hasEvents ? new Date(`${firstEventRows[0].firstEvent}Z`) : null;

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

  console.log(`ClickHouse first User.commentCount event: ${firstEvent.toISOString()}`);
  console.log(`  boundary for post/image/article/bounty: ${firstEvent.toISOString()}`);
  console.log(`  boundary for every other surface:       ${newCutover.toISOString()}`);
  console.log(EXECUTE ? '\nMODE: EXECUTE, this will write.\n' : '\nMODE: dry run, nothing is written.\n');

  const pool = new pg.Pool({
    connectionString:
      process.env.DATABASE_REPLICA_URL ?? pgEnv.DATABASE_REPLICA_URL ?? pgEnv.DATABASE_URL,
    connectionTimeoutMillis: 30000,
    max: 4,
  });

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
    const { rows } = await pool.query(commentV2Sql(surface), [boundary]);
    for (const row of rows) add(row.ownerId, row.day.toISOString().slice(0, 10), row.total);
    report(surface.key, rows, started);
  }

  {
    const started = Date.now();
    const { rows } = await pool.query(LEGACY_MODEL_SQL, [newCutover]);
    for (const row of rows) add(row.ownerId, row.day.toISOString().slice(0, 10), row.total);
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

  // A day that also carries live events would be REPLACED rather than added to, so the overlap is
  // reported rather than written. It is small by construction (the boundary day of each group) and
  // wrong to guess at.
  const boundaryDays = new Set([
    firstEvent.toISOString().slice(0, 10),
    newCutover.toISOString().slice(0, 10),
  ]);
  const overlap = rowsToWrite.filter((row) => boundaryDays.has(row.day));
  const safeRows = rowsToWrite.filter((row) => !boundaryDays.has(row.day));
  if (overlap.length) {
    const overlapTotal = overlap.reduce((sum, row) => sum + row.total, 0);
    console.log(
      `\n${overlap.length} rows fall on a boundary day (${[...boundaryDays].join(', ')}) holding ` +
        `${overlapTotal} comments. Those days already carry live totals, so writing them would ` +
        `replace the live value. Excluded here; they need an explicit merge.`
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
    console.log(`(${byOwner.size}) so the additive refresher recomputes each total.`);
    console.log('\nSample:');
    for (const row of safeRows.slice(0, 5)) console.log(' ', JSON.stringify(row));
    await ch.close();
    return;
  }

  const limited = LIMIT ? safeRows.slice(0, LIMIT) : safeRows;
  const BATCH = 50000;
  for (let i = 0; i < limited.length; i += BATCH) {
    await ch.insert({
      table: 'entityMetricDailyAgg_history_v2',
      values: limited.slice(i, i + BATCH),
      format: 'JSONEachRow',
    });
    console.log(`wrote ${Math.min(i + BATCH, limited.length)}/${limited.length} day rows`);
  }

  const dirty = [...new Set(limited.map((row) => row.entityId))].map((entityId) => ({
    entityType: 'User',
    entityId,
    metricType: 'commentCount',
  }));
  for (let i = 0; i < dirty.length; i += BATCH) {
    await ch.insert({
      table: 'entityMetricDirty_v3',
      values: dirty.slice(i, i + BATCH),
      format: 'JSONEachRow',
    });
  }
  console.log(`marked ${dirty.length} owners dirty`);

  await ch.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
