// Merge one boundary day: backfill total + already-sealed live total, written with a fresh
// sealedAt so argMax(total, sealedAt) picks the merged value. Only safe AFTER that day is sealed,
// otherwise the daily seal appends a live-only row with a newer sealedAt and wins.
import pg from 'pg';
import { createClient } from '@clickhouse/client';

const DAY = process.argv[2];
const EXECUTE = process.argv.includes('--execute');
const OLD_CUT = '2026-08-17 21:28:21';
const NEW_CUT = '2026-08-18 05:43:30';
const OLD = new Set(['post', 'image', 'article', 'bounty']);

const S = [
  ['post','postId','"Post"','"userId"'],['image','imageId','"Image"','"userId"'],
  ['article','articleId','"Article"','"userId"'],['bounty','bountyId','"Bounty"','"userId"'],
  ['review','reviewId','"ResourceReview"','"userId"'],['bountyEntry','bountyEntryId','"BountyEntry"','"userId"'],
  ['challenge','challengeId','"Challenge"','"createdById"'],['comic','comicProjectId','"ComicProject"','"userId"'],
  ['clubPost','clubPostId','"ClubPost"','"createdById"'],['model3d','model3dId','"Model3D"','"userId"'],
  ['model3dReview','model3dReviewId','"Model3DReview"','"userId"'],['modelV2','modelId','"Model"','"userId"'],
  ['question','questionId','"Question"','"userId"'],['answer','answerId','"Answer"','"userId"'],
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_REPLICA_URL, max: 4 });
const ch = createClient({
  url: process.env.CLICKHOUSE_HOST,
  username: process.env.CLICKHOUSE_USERNAME,
  password: process.env.CLICKHOUSE_PASSWORD,
  request_timeout: 300000,
});
const q = async (sql) => (await ch.query({ query: sql, format: 'JSONEachRow' })).json();

const sealRows = await q(`SELECT view, next_refresh_time FROM system.view_refreshes
                          WHERE view = 'entityMetricDailySeal_v2_mv'`);
const nextSeal = sealRows[0]?.next_refresh_time;
const sealedFor = await q(`SELECT count() AS n FROM default.entityMetricDailyAgg_history_v2
                           WHERE entityType='User' AND metricType='commentCount' AND day = '${DAY}'`);
console.log(`day ${DAY}: existing history rows ${sealedFor[0].n}; next seal ${nextSeal}`);
if (Number(sealedFor[0].n) === 0) {
  console.error(`Refusing: ${DAY} has no sealed rows yet. Merging before the seal loses to it —`);
  console.error('the seal appends a live-only row with a newer sealedAt and argMax picks that.');
  process.exit(1);
}

const excluded = (await q(`SELECT userId FROM default.metricExcludedUsers FINAL WHERE active = 1`))
  .map((r) => Number(r.userId));

const backfill = new Map();
for (const [key, fk, tbl, col] of S) {
  const bound = OLD.has(key) ? OLD_CUT : NEW_CUT;
  const { rows } = await pool.query(
    `SELECT e.${col} AS owner, count(*)::int AS n
     FROM "CommentV2" c JOIN "Thread" t ON t.id = c."threadId"
     LEFT JOIN "Thread" r ON r.id = t."rootThreadId"
     JOIN ${tbl} e ON e.id = COALESCE(r."${fk}", t."${fk}")
     WHERE to_char(c."createdAt",'YYYY-MM-DD') = $1
       AND c."createdAt" < timestamp '${bound}'
       AND e.${col} IS NOT NULL AND e.${col} <> c."userId" AND c."userId" <> ALL($2::int[])
     GROUP BY 1`,
    [DAY, excluded]
  );
  for (const r of rows) backfill.set(r.owner, (backfill.get(r.owner) ?? 0) + r.n);
}
{
  const { rows } = await pool.query(
    `SELECT m."userId" AS owner, count(*)::int AS n
     FROM "Comment" c JOIN "Model" m ON m.id = c."modelId"
     WHERE to_char(c."createdAt",'YYYY-MM-DD') = $1 AND c."createdAt" < timestamp '${NEW_CUT}'
       AND m."userId" <> c."userId" AND c."userId" <> ALL($2::int[])
     GROUP BY 1`,
    [DAY, excluded]
  );
  for (const r of rows) backfill.set(r.owner, (backfill.get(r.owner) ?? 0) + r.n);
}

const live = new Map();
for (const r of await q(`SELECT entityId, argMax(total, sealedAt) AS t
                         FROM default.entityMetricDailyAgg_history_v2
                         WHERE entityType='User' AND metricType='commentCount' AND day='${DAY}'
                         GROUP BY entityId`)) {
  live.set(Number(r.entityId), Number(r.t));
}

const owners = new Set([...backfill.keys(), ...live.keys()]);
const rows = [...owners].map((entityId) => ({
  entityType: 'User',
  entityId,
  metricType: 'commentCount',
  day: DAY,
  total: (backfill.get(entityId) ?? 0) + (live.get(entityId) ?? 0),
}));
const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
console.log(`backfill ${sum(backfill)} across ${backfill.size} owners`);
console.log(`live     ${sum(live)} across ${live.size} owners`);
console.log(`merged   ${rows.reduce((a, r) => a + r.total, 0)} across ${rows.length} owners`);
console.log('sample:', JSON.stringify(rows.slice(0, 3)));

if (!EXECUTE) {
  console.log('\nDry run — nothing written. Pass --execute to write.');
} else {
  await ch.insert({ table: 'entityMetricDailyAgg_history_v2', values: rows, format: 'JSONEachRow' });
  await ch.insert({
    table: 'entityMetricDirty_v3',
    values: rows.map((r) => ({ entityType: 'User', entityId: r.entityId, metricType: 'commentCount' })),
    format: 'JSONEachRow',
  });
  console.log(`\nwrote ${rows.length} merged rows and flagged the same owners`);
}
await pool.end();
await ch.close();
