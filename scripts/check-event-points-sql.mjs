// Checks the event points referee query (src/server/events/points/referee.sql.ts) against hand-built
// fixtures, whole and in actor shards merged as the settle job merges them. CI has no ClickHouse, so
// this is the query's semantic test: run it after any change to the SQL or the merge. The fixtures
// are CTEs that shadow the real tables and the session is readonly, so it reads no real rows and
// writes nothing; any ClickHouse server works.
//
// Usage: CLICKHOUSE_HOST=... CLICKHOUSE_USERNAME=... CLICKHOUSE_PASSWORD=... \
//          node scripts/check-event-points-sql.mjs ['<text to replace>=><replacement>']
// The optional argument applies one mutation to the query; a correct check prints MISMATCH for it.
import { createClient } from '@clickhouse/client';
import { readFileSync } from 'fs';
import { refereeShardMerge } from '../src/server/events/points/referee-shards.ts';

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
    more.players ?? [],
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
// Actor 17 reacted, took it back, and reacted again after the end: the late re-add must not revive it.
add('2026-11-01 10:40:00', 'reaction', 17, 110, H10, 'R:110:17');
add('2026-11-01 10:41:00', 'reaction', 17, 110, H10, 'R:110:17', 'remove');
add('2026-11-03 06:30:00', 'reaction', 17, 110, H10, 'R:110:17');

// Turf: a row with no owner names the players it credits, each under their own hat key. Player 11 is
// banned and earns nothing; actor 30 acting on turf they hold credits only the other player.
const TURF = [0, 60, 'turf', 'Green'];
add('2026-11-01 14:00:00', 'reaction', 20, 700, TURF, 'R:700:20', 'add', { players: [30, 31, 11] });
add('2026-11-01 15:00:00', 'reaction', 30, 701, TURF, 'R:701:30', 'add', { players: [30, 31] });

// Excluded from day two on (restrictedFrom): owner 40 wearing hat 70, actor 42 and turf player 45
// keep what they gave and earned on day one, and nothing counts from day two.
const H40 = [40, 70, 'claimed', 'Red'];
add('2026-11-01 08:00:00', 'reaction', 43, 800, H40, 'R:800:43');
add('2026-11-02 08:00:00', 'reaction', 44, 801, H40, 'R:801:44');
add('2026-11-01 09:00:00', 'view', 42, 802, H40);
add('2026-11-02 09:00:00', 'view', 42, 602, H1000);
add('2026-11-01 16:00:00', 'reaction', 20, 702, TURF, 'R:702:20', 'add', { players: [45] });
add('2026-11-02 16:00:00', 'reaction', 20, 703, TURF, 'R:703:20', 'add', { players: [45] });

const q = (v) =>
  Array.isArray(v) ? `[${v.join(', ')}]` : typeof v === 'number' ? String(v) : `'${v}'`;
const rows = (list) => list.map((r) => `(${r.map(q).join(', ')})`).join(', ');
const withLedger = (list) => `
  event_point_events AS (
    SELECT event, toDateTime64(t, 3, 'UTC') AS time, type, op, actorId, entityType, entityId,
      ownerId, cosmeticId, claimKey, team, sourceId, players
    FROM values('event String, t String, type String, op String, actorId Int32, entityType String,
      entityId Int32, ownerId Int32, cosmeticId Int32, claimKey String, team String,
      sourceId String, players Array(Int32)', ${rows(list)})
  ),`;
const fixtureSql = one(sql, 'WITH\n', `WITH\n${withLedger(ledger)}\n`);

// day, userId, cosmeticId, claimKey, team, points, views, reactions, comments, stickers, remixes,
// modelLikes, points per UTC hour. An action's hour is its first add's, even when a later re-add
// is what made it count (actor 1 at 01:00).
const full = [
  [
    ...[
      '2026-11-01',
      10,
      7,
      'claimed',
      'Yellow',
      5 + 45 + 1 + 5 + 20 + 5 + 5 + 5,
      46,
      5,
      1,
      1,
      0,
      1,
    ],
    { 1: 5, 4: 45, 6: 1, 9: 5, 10: 20 + 5, 11: 5, 13: 5 },
  ],
  ['2026-11-01', 10, 9, 'cosmetic-purchase-x', 'Yellow', 5, 0, 0, 0, 0, 1, 0, { 5: 5 }],
  ['2026-11-01', 30, 60, 'turf', 'Green', 5, 0, 1, 0, 0, 0, 0, { 14: 5 }],
  ['2026-11-01', 31, 60, 'turf', 'Green', 5 + 5, 0, 2, 0, 0, 0, 0, { 14: 5, 15: 5 }],
  ['2026-11-01', 40, 70, 'claimed', 'Red', 5 + 1, 1, 1, 0, 0, 0, 0, { 8: 5, 9: 1 }],
  ['2026-11-01', 45, 60, 'turf', 'Green', 5, 0, 1, 0, 0, 0, 0, { 16: 5 }],
  ['2026-11-01', 1000, 9, 'claimed', 'Pink', 5 + 1, 1, 1, 0, 0, 0, 0, { 5: 1, 8: 5 }],
  ['2026-11-02', 10, 7, 'claimed', 'Yellow', 2, 2, 0, 0, 0, 0, 0, { 4: 1, 6: 1 }],
];
// The hourly run from day two: day one is final and not returned, and actor 9's day-two log is not a
// new first, because the event-scoped first was on day one.
const partial = [['2026-11-02', 10, 7, 'claimed', 'Yellow', 2, 2, 0, 0, 0, 0, 0, { 4: 1, 6: 1 }]];

const client = createClient({
  url: process.env.CLICKHOUSE_HOST,
  username: process.env.CLICKHOUSE_USERNAME,
  password: process.env.CLICKHOUSE_PASSWORD,
  clickhouse_settings: { readonly: '1' },
});
const PARAMS = {
  event: 'e',
  seasonStart: '2026-11-01 00:00:00.000',
  cut: '2026-11-03 00:00:00.000',
  removeCut: '2026-11-03 12:00:00.000',
  cap: 50,
  types: ['view', 'reaction', 'comment', 'sticker', 'remix', 'modelLike'],
  weights: [1, 5, 5, 10, 25, 5],
  dailyTypes: ['view'],
  restrictedUsers: [4, 11, 40, 42, 45],
  restrictedFrom: [0, 0, ...Array(3).fill(Date.UTC(2026, 10, 2))],
  newAccountMinId: 1000,
};
// Runs the query once per actor shard and merges the shards as the settle job does. `shared` counts
// the merged rows more than one shard contributed to: a split that never meets in the merge tests
// nothing.
async function run(query, recomputeFrom, shards = 1, params = PARAMS) {
  const merge = refereeShardMerge();
  const seen = new Map();
  for (let actorShard = 0; actorShard < shards; actorShard++) {
    const result = await client.query({
      query,
      format: 'JSONEachRow',
      query_params: { ...params, recomputeFrom, actorShards: shards, actorShard },
    });
    const raw = await result.json();
    for (const r of raw) {
      const key = JSON.stringify([r.day, r.userId, r.cosmeticId, r.claimKey]);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    merge.add(raw);
  }
  const rows = merge.rows().map((r) => [
    r.day,
    r.userId,
    r.cosmeticId,
    r.claimKey,
    r.team,
    ...['points', 'views', 'reactions', 'comments', 'stickers', 'remixes', 'modelLikes'].map(
      (k) => r[k]
    ),
    // An hour credited nothing (a capped action) reads the same whether listed as 0 or left out.
    Object.fromEntries(Object.entries(r.hours).filter(([, points]) => points)),
  ]);
  return { rows, shared: [...seen.values()].filter((n) => n > 1).length };
}

// A generated season, built in ClickHouse from hashes of numbers() (a literal this size is slow
// for the server to analyze): many actors and hats, removals and re-adds, turf players, exclusions and
// a cap that bites, so the split cuts across every rule. Deterministic, so a failure reproduces.
const generatedLedger = `
  event_point_events AS (
    SELECT 'e' AS event,
      toDateTime64('2026-11-01 00:00:00', 3, 'UTC') + toIntervalSecond(cityHash64(number, 1) % 259200) AS time,
      ['reaction', 'comment', 'sticker', 'remix', 'modelLike', 'view'][1 + cityHash64(number, 2) % 6] AS type,
      if(sourceId != '' AND cityHash64(number, 3) % 4 = 0, 'remove', 'add') AS op,
      toInt32(1 + cityHash64(number, 4) % 120) AS actorId,
      'Image' AS entityType,
      toInt32(5000 + cityHash64(number, 5) % 40) AS entityId,
      cityHash64(number, 6) % 10 = 0 AS turf,
      cityHash64(number, 7) % 24 AS hatIdx,
      if(turf, 0, toInt32(200 + hatIdx % 12)) AS ownerId,
      toInt32(if(turf, 60, 300 + hatIdx)) AS cosmeticId,
      if(turf, 'turf', if(hatIdx % 5 = 0, 'cosmetic-purchase-x', 'claimed')) AS claimKey,
      if(turf, 'Green', ['Red', 'Blue', 'Green'][1 + hatIdx % 3]) AS team,
      if(type = 'view' AND NOT turf, '', concat(type, ':', toString(entityId), ':', toString(actorId))) AS sourceId,
      if(turf, [toInt32(200 + cityHash64(number, 8) % 12), toInt32(200 + cityHash64(number, 9) % 12),
        toInt32(990 + cityHash64(number, 10) % 3)], CAST([], 'Array(Int32)')) AS players
    FROM numbers(6000)
  ),`;
const genParams = {
  ...PARAMS,
  cap: 30,
  restrictedUsers: [5, 6, 201, 207, 991],
  restrictedFrom: [0, Date.UTC(2026, 10, 2), 0, Date.UTC(2026, 10, 2, 12), Date.UTC(2026, 10, 2)],
  newAccountMinId: 110,
};
const genSql = one(sql, 'WITH\n', `WITH\n${generatedLedger}\n`);

const DAY1 = '2026-11-01 00:00:00.000';
const DAY2 = '2026-11-02 00:00:00.000';
const gotFull = await run(fixtureSql, DAY1);
const gotPartial = await run(fixtureSql, DAY2);
const gotFullSplit = await run(fixtureSql, DAY1, 3);
const gotPartialSplit = await run(fixtureSql, DAY2, 3);
const genWhole = await run(genSql, DAY1, 1, genParams);
const genSplit = await run(genSql, DAY1, 5, genParams);
const genPartialWhole = await run(genSql, DAY2, 1, genParams);
const genPartialSplit = await run(genSql, DAY2, 4, genParams);
await client.close();

const same = (a, b) => JSON.stringify(a.rows) === JSON.stringify(b);
const checks = {
  // Every row's hours add up to its points, whatever the fixture expects.
  hoursSum: [gotFull, gotPartial, gotFullSplit, genWhole, genSplit].every(({ rows }) =>
    rows.every((r) => Object.values(r[12]).reduce((a, b) => a + b, 0) === r[5])
  ),
  full: same(gotFull, full),
  partial: same(gotPartial, partial),
  fullSplit: same(gotFullSplit, full),
  partialSplit: same(gotPartialSplit, partial),
  generatedSplit: same(genSplit, genWhole.rows),
  generatedPartialSplit: same(genPartialSplit, genPartialWhole.rows),
  // The generated season must score and hit the cap, and its split must meet in the merge, or the
  // comparisons above prove nothing.
  generatedScores: genWhole.rows.length > 50 && genPartialWhole.rows.length > 10,
  generatedCapBites: genWhole.rows.some((r) => r[5] >= genParams.cap),
  splitMeets: gotFullSplit.shared > 0 && genSplit.shared > 50 && genPartialSplit.shared > 0,
};
const ok = Object.values(checks).every(Boolean);
console.log(ok ? 'MATCH' : 'MISMATCH');
console.log(
  JSON.stringify({
    generatedRows: genWhole.rows.length,
    generatedPartialRows: genPartialWhole.rows.length,
    merged: {
      fixture: gotFullSplit.shared,
      generated: genSplit.shared,
      generatedPartial: genPartialSplit.shared,
    },
  })
);
if (!ok)
  console.log(
    JSON.stringify(
      { checks, full, gotFull, gotFullSplit, partial, gotPartial, gotPartialSplit },
      null,
      1
    )
  );
process.exit(ok ? 0 : 1);
