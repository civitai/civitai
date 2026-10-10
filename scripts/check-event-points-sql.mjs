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
const START = 'eventPointsRefereeSql = /* sql */ `';
const from = src.indexOf(START) + START.length;
let sql = src.slice(from, src.indexOf('`;', from));
const one = (s, a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor x${n}: ${a}`);
  return s.replace(a, () => b);
};
if (mutant) {
  const [a, b] = mutant.split('=>');
  sql = one(sql, a, b);
}

// Owner 10 wears hat 7 on images 100-199 and a bought copy, hat 9, on images 200-299. Owner 11 (banned)
// wears hat 8 on image 500.
const H10 = [10, 7, 'claimed', 'Yellow'];
const H10B = [10, 9, 'cosmetic-purchase-x', 'Yellow'];
const H11 = [11, 8, 'claimed', 'Blue'];
// A new account's hat: new accounts cannot give, but they still earn.
const H1000 = [1000, 9, 'claimed', 'Pink'];
const ledger = [];
const add = (time, type, actorId, entityId, hat, sourceId = '', op = 'add', more = {}) =>
  ledger.push([
    more.event ?? 'e',
    time,
    type,
    op,
    actorId,
    more.entityType ?? 'Image',
    entityId,
    ...hat,
    sourceId,
  ]);

// Actor 1: reaction removed (nets out); a second sourceId removed then re-added (counts once).
add('2026-11-01 01:00:00', 'reaction', 1, 100, H10, 'R:100:1');
add('2026-11-01 02:00:00', 'reaction', 1, 100, H10, 'R:100:1', 'remove');
add('2026-11-01 01:00:00', 'reaction', 1, 101, H10, 'R:101:1');
add('2026-11-01 02:00:00', 'reaction', 1, 101, H10, 'R:101:1', 'remove');
add('2026-11-01 03:00:00', 'reaction', 1, 101, H10, 'R:101:1');
// Actor 2 on day one: 45 views on hat 7 (45), then a remix on the SAME owner's other hat (25, of
// which 5 fits: the cap is per creator, not per hat), then a reaction (nothing left).
for (let i = 0; i < 45; i++)
  add(`2026-11-01 04:${String(i).padStart(2, '0')}:00`, 'view', 2, 110 + i, H10);
add('2026-11-01 05:00:00', 'remix', 2, 200, H10B, 'P:remix:200:2');
add('2026-11-01 05:01:00', 'reaction', 2, 161, H10, 'R:161:2');
// The cap is per creator: past 50 on owner 10, a view to another creator's hat still earns.
add('2026-11-01 05:02:00', 'view', 2, 601, H1000);
// ...and on day two the cap starts over: a view to the same creator earns again.
add('2026-11-02 04:00:00', 'view', 2, 110, H10);
// Actor 3: the same view twice on day one counts once, and again on day two.
add('2026-11-01 06:00:00', 'view', 3, 100, H10);
add('2026-11-01 07:00:00', 'view', 3, 100, H10);
add('2026-11-02 06:00:00', 'view', 3, 100, H10);
// Actor 9: a reaction logged again a day later (a lost dedupe key) still counts once for the event.
add('2026-11-01 09:00:00', 'reaction', 9, 102, H10, 'R:102:9');
add('2026-11-02 09:00:00', 'reaction', 9, 102, H10, 'R:102:9');
// Actor 12: a comment, a sticker and a model thumbs up, each at its own weight.
add('2026-11-01 10:00:00', 'comment', 12, 103, H10, 'C:103:12');
add('2026-11-01 10:01:00', 'sticker', 12, 104, H10, 'P:sticker:104:12');
add('2026-11-01 10:02:00', 'modelLike', 12, 50, H10, 'RR:50:12', 'add', { entityType: 'Model' });
// Actor 13: the post changed hats between two logs of the same reaction; the first hat keeps it.
add('2026-11-01 11:00:00', 'reaction', 13, 105, H10, 'R:105:13');
add('2026-11-01 12:00:00', 'reaction', 13, 105, H10B, 'R:105:13');
// Actor 4 (banned or excluded) and actor 1000 (new account: ids from 1000 registered inside the
// window) earn nobody anything; actor 6 reacts on the banned owner's hat: nothing.
add('2026-11-01 08:00:00', 'reaction', 4, 100, H10, 'R:100:4');
add('2026-11-01 08:00:00', 'reaction', 1000, 100, H10, 'R:100:1000');
add('2026-11-01 08:00:00', 'reaction', 6, 500, H11, 'R:500:6');
add('2026-11-01 08:00:00', 'reaction', 3, 600, H1000, 'R:600:3');
// The owner reacting on their own hat earns nothing.
add('2026-11-01 08:00:00', 'reaction', 10, 107, H10, 'R:107:10');
// Another event's row, and rows outside the season window: before its start and at the cut.
add('2026-11-01 08:00:00', 'reaction', 14, 106, H10, 'R:106:14', 'add', { event: 'other' });
add('2026-10-31 23:59:00', 'reaction', 7, 100, H10, 'R:100:7');
// Actor 7 reacted in the preview and again in the event: the preview row must not hide the event's.
add('2026-11-01 13:00:00', 'reaction', 7, 100, H10, 'R:100:7');
add('2026-11-03 00:00:00', 'reaction', 8, 100, H10, 'R:100:8');
// The season ends at the cut, but removals keep landing through the finalize window (to removeCut):
// actor 15's takedown after the end nets out a day-one add; actor 16's, after removeCut, does not.
add('2026-11-01 10:30:00', 'reaction', 15, 108, H10, 'R:108:15');
add('2026-11-03 06:00:00', 'reaction', 15, 108, H10, 'R:108:15', 'remove');
add('2026-11-01 10:31:00', 'reaction', 16, 109, H10, 'R:109:16');
add('2026-11-03 13:00:00', 'reaction', 16, 109, H10, 'R:109:16', 'remove');

const q = (v) => (typeof v === 'number' ? String(v) : `'${v}'`);
const rows = (list) => list.map((r) => `(${r.map(q).join(', ')})`).join(', ');
const fixtures = `
  event_point_events AS (
    SELECT event, toDateTime64(t, 3, 'UTC') AS time, type, op, actorId, entityType, entityId,
      ownerId, cosmeticId, claimKey, team, sourceId
    FROM values('event String, t String, type String, op String, actorId Int32, entityType String,
      entityId Int32, ownerId Int32, cosmeticId Int32, claimKey String, team String,
      sourceId String', ${rows(ledger)})
  ),`;
sql = one(sql, 'WITH\n', `WITH\n${fixtures}\n`);

// day, userId, cosmeticId, claimKey, team, points, views, reactions, comments, stickers, remixes,
// modelLikes
const full = [
  ['2026-11-01', 10, 7, 'claimed', 'Yellow', 5 + 45 + 1 + 5 + 20 + 5 + 5 + 5, 46, 5, 1, 1, 0, 1],
  ['2026-11-01', 10, 9, 'cosmetic-purchase-x', 'Yellow', 5, 0, 0, 0, 0, 1, 0],
  ['2026-11-01', 1000, 9, 'claimed', 'Pink', 5 + 1, 1, 1, 0, 0, 0, 0],
  ['2026-11-02', 10, 7, 'claimed', 'Yellow', 2, 2, 0, 0, 0, 0, 0],
];
// The hourly run from day two: day one is final and not returned, and actor 9's day-two log is not a
// new first, because the event-scoped first was on day one.
const partial = [['2026-11-02', 10, 7, 'claimed', 'Yellow', 2, 2, 0, 0, 0, 0, 0]];

const client = createClient({
  url: process.env.CLICKHOUSE_HOST,
  username: process.env.CLICKHOUSE_USERNAME,
  password: process.env.CLICKHOUSE_PASSWORD,
  clickhouse_settings: { readonly: '1' },
});
async function run(recomputeFrom) {
  const result = await client.query({
    query: sql,
    format: 'JSONEachRow',
    query_params: {
      event: 'e',
      seasonStart: '2026-11-01 00:00:00.000',
      recomputeFrom,
      cut: '2026-11-03 00:00:00.000',
      removeCut: '2026-11-03 12:00:00.000',
      cap: 50,
      types: ['view', 'reaction', 'comment', 'sticker', 'remix', 'modelLike'],
      weights: [1, 5, 5, 10, 25, 5],
      dailyTypes: ['view'],
      restrictedUsers: [4, 11],
      newAccountMinId: 1000,
    },
  });
  return (await result.json()).map((r) => [
    r.day,
    Number(r.userId),
    Number(r.cosmeticId),
    r.claimKey,
    r.team,
    ...['points', 'views', 'reactions', 'comments', 'stickers', 'remixes', 'modelLikes'].map((k) =>
      Number(r[k])
    ),
  ]);
}
const gotFull = await run('2026-11-01 00:00:00.000');
const gotPartial = await run('2026-11-02 00:00:00.000');
await client.close();

const ok =
  JSON.stringify(gotFull) === JSON.stringify(full) &&
  JSON.stringify(gotPartial) === JSON.stringify(partial);
console.log(ok ? 'MATCH' : 'MISMATCH');
if (!ok) console.log(JSON.stringify({ full, gotFull, partial, gotPartial }, null, 1));
process.exit(ok ? 0 : 1);
