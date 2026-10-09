// Checks the event points referee query (src/server/events/points/referee.sql.ts) against hand-built
// fixtures. CI has no ClickHouse, so this is the query's semantic test: run it after any change to
// the SQL. The fixtures are CTEs that shadow the real tables and the session is readonly, so it reads
// no real rows and writes nothing; any ClickHouse server works.
//
// Usage: CLICKHOUSE_HOST=... CLICKHOUSE_USERNAME=... CLICKHOUSE_PASSWORD=... \
//          node scripts/check-event-points-sql.mjs ['<text to replace>=><replacement>']
// The optional argument applies one mutation to the query; a correct check prints MISMATCH for it.
import { createClient } from '@clickhouse/client';
import { readFileSync } from 'fs';

const [mutant] = process.argv.slice(2);
const src = readFileSync(
  new URL('../src/server/events/points/referee.sql.ts', import.meta.url),
  'utf8'
);
const START = '/* sql */ `';
let sql = src.slice(src.indexOf(START) + START.length, src.lastIndexOf('`'));
const one = (s, a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor x${n}: ${a}`);
  return s.replace(a, () => b);
};
if (mutant) {
  const [a, b] = mutant.split('=>');
  sql = one(sql, a, b);
}

// Owner 10 wears hat 7 on images 100-199; owner 11 (banned) wears hat 8 on image 500.
const H10 = [10, 7, 'claimed', 'Yellow'];
const H11 = [11, 8, 'claimed', 'Blue'];
const ledger = [];
const add = (time, type, actorId, entityId, hat, sourceId = '', op = 'add') =>
  ledger.push([time, type, op, actorId, 'Image', entityId, ...hat, sourceId]);

// Actor 1: reaction removed (nets out); a second sourceId removed then re-added (counts once).
add('2026-11-01 01:00:00', 'reaction', 1, 100, H10, 'R:100:1');
add('2026-11-01 02:00:00', 'reaction', 1, 100, H10, 'R:100:1', 'remove');
add('2026-11-01 01:00:00', 'reaction', 1, 101, H10, 'R:101:1');
add('2026-11-01 02:00:00', 'reaction', 1, 101, H10, 'R:101:1', 'remove');
add('2026-11-01 03:00:00', 'reaction', 1, 101, H10, 'R:101:1');
// Actor 2 on day one: 45 views (45), a remix (25, of which 5 fits), a reaction (nothing left).
for (let i = 0; i < 45; i++)
  add(`2026-11-01 04:${String(i).padStart(2, '0')}:00`, 'view', 2, 110 + i, H10);
add('2026-11-01 05:00:00', 'remix', 2, 160, H10, 'P:160:2');
add('2026-11-01 05:01:00', 'reaction', 2, 161, H10, 'R:161:2');
// Actor 3: the same view twice on day one counts once, and again on day two.
add('2026-11-01 06:00:00', 'view', 3, 100, H10);
add('2026-11-01 07:00:00', 'view', 3, 100, H10);
add('2026-11-02 06:00:00', 'view', 3, 100, H10);
// Actor 9: a reaction logged again a day later (a lost dedupe key) still counts once for the event.
add('2026-11-01 09:00:00', 'reaction', 9, 102, H10, 'R:102:9');
add('2026-11-02 09:00:00', 'reaction', 9, 102, H10, 'R:102:9');
// Actor 4 is banned, actor 5 is a new account: nothing. Actor 6 on the banned owner's hat: nothing.
add('2026-11-01 08:00:00', 'reaction', 4, 100, H10, 'R:100:4');
add('2026-11-01 08:00:00', 'reaction', 5, 100, H10, 'R:100:5');
add('2026-11-01 08:00:00', 'reaction', 6, 500, H11, 'R:500:6');
// Outside the season window: before its start (preview) and at the cut.
add('2026-10-31 23:59:00', 'reaction', 7, 100, H10, 'R:100:7');
add('2026-11-03 00:00:00', 'reaction', 8, 100, H10, 'R:100:8');

const activities = [
  ['Banned', 4, '2026-10-01 00:00:00'],
  ['Banned', 11, '2026-10-01 00:00:00'],
  ['Registration', 5, '2026-10-28 00:00:00'],
  ['Registration', 6, '2026-01-01 00:00:00'],
  // Banned then unbanned: counts.
  ['Banned', 3, '2026-09-01 00:00:00'],
  ['Unbanned', 3, '2026-09-02 00:00:00'],
];

const q = (v) => (typeof v === 'number' ? String(v) : `'${v}'`);
const rows = (list) => list.map((r) => `(${r.map(q).join(', ')})`).join(', ');
const fixtures = `
  event_point_events AS (
    SELECT 'e' AS event, toDateTime64(t, 3, 'UTC') AS time, type, op, actorId, entityType, entityId,
      ownerId, cosmeticId, claimKey, team, sourceId
    FROM values('t String, type String, op String, actorId Int32, entityType String, entityId Int32,
      ownerId Int32, cosmeticId Int32, claimKey String, team String, sourceId String', ${rows(
        ledger
      )})
  ),
  userActivities AS (
    SELECT type, targetUserId, toDateTime64(t, 3, 'UTC') AS time
    FROM values('type String, targetUserId Int32, t String', ${rows(activities)})
  ),`;
sql = one(sql, 'WITH\n', `WITH\n${fixtures}\n`);

const expected = [
  // day, userId, cosmeticId, points, views, reactions, remixes
  ['2026-11-01', 10, 7, 5 + 45 + 5 + 1 + 5, 46, 2, 1],
  ['2026-11-02', 10, 7, 1, 1, 0, 0],
];

const client = createClient({
  url: process.env.CLICKHOUSE_HOST,
  username: process.env.CLICKHOUSE_USERNAME,
  password: process.env.CLICKHOUSE_PASSWORD,
  clickhouse_settings: { readonly: '1' },
});
const result = await client.query({
  query: sql,
  format: 'JSONEachRow',
  query_params: {
    event: 'e',
    seasonStart: '2026-11-01 00:00:00.000',
    cut: '2026-11-03 00:00:00.000',
    newAccountCutoff: '2026-10-25 00:00:00.000',
    cap: 50,
    types: ['view', 'reaction', 'comment', 'sticker', 'remix', 'modelLike'],
    weights: [1, 5, 5, 10, 25, 5],
    dailyTypes: ['view'],
  },
});
const got = (await result.json()).map((r) => [
  r.day,
  Number(r.userId),
  Number(r.cosmeticId),
  Number(r.points),
  Number(r.views),
  Number(r.reactions),
  Number(r.remixes),
]);
await client.close();

const ok = JSON.stringify(got) === JSON.stringify(expected);
console.log(ok ? 'MATCH' : 'MISMATCH');
if (!ok) console.log({ expected, got });
process.exit(ok ? 0 : 1);
