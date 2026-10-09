// Checks the event score query's rules (src/server/events/scoring/cosmetic-placement.sql.ts) against
// hand-built fixtures. CI has no ClickHouse, so this is the query's semantic test: run it after any
// change to the SQL. The fixtures are CTEs that shadow the real tables and the session is readonly,
// so it reads no real rows and writes nothing; any ClickHouse server works.
//
// Usage: CLICKHOUSE_HOST=... CLICKHOUSE_USERNAME=... CLICKHOUSE_PASSWORD=... \
//          node scripts/check-event-score-sql.mjs ['<text to replace>=><replacement>']
// The optional argument applies one mutation to the query; a correct check prints MISMATCH for it.
import { createClient } from '@clickhouse/client';
import { readFileSync } from 'fs';

const [mutant] = process.argv.slice(2);
const src = readFileSync(
  new URL('../src/server/events/scoring/cosmetic-placement.sql.ts', import.meta.url),
  'utf8'
);
const START = '/* sql */ `';
let sql = src.slice(src.indexOf(START) + START.length, src.lastIndexOf('`'));
const one = (s, a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor x${n}: ${a}`);
  return s.replace(a, () => b);
};
sql = one(sql, 'event_cosmetic_placements FINAL', 'event_cosmetic_placements');
if (mutant) {
  const [a, b] = mutant.split('=>');
  sql = one(sql, a, b);
}

const imp = [
  // entityType, entityId, userId, sessionKey, time
  ['Image', 10, 50, 'x', '08 01:00:00'],
  ['Image', 10, 50, 'y', '08 02:00:00'],
  ['Image', 10, 1, 'z', '08 01:00:00'],
  ['Image', 10, 51, 'z', '08 01:00:00'],
  ['Image', 10, 52, 'z', '08 01:00:00'],
  ['Image', 10, 0, 's1', '08 01:00:00'],
  ['Image', 10, 0, 's1', '08 03:00:00'],
  ['Image', 10, 0, 'bot', '08 01:00:00'],
  ['Image', 90, 0, 'bot', '08 01:00:00'],
  ['Image', 91, 0, 'bot', '08 01:00:00'],
  ['Image', 92, 0, 'bot', '08 01:00:00'],
  ['Image', 11, 50, 'x', '08 08:00:00'],
  ['Image', 11, 53, 'x', '08 13:00:00'],
  ['Image', 20, 50, 'x', '08 01:00:00'],
  ['Image', 40, 60, 'x', '08 03:00:00'],
  ['Image', 40, 60, 'x', '08 09:00:00'],
  ['Image', 40, 61, 'x', '08 09:00:00'],
  ['Image', 12, 50, 'x', '08 01:00:00'],
  ...Array.from({ length: 15 }, (_, k) => ['Image', 12, 0, `anon${k}`, '08 01:00:00']),
  ['Image', 10, 70, 'x', '08 13:00:00'],
  ['Image', 11, 70, 'x', '08 13:00:00'],
  ['Image', 13, 70, 'x', '08 13:00:00'],
  ['Image', 10, 80, 'x', '09 01:00:00'], // next day: outside the window
  ['Image', 60, 62, 'x', '08 01:00:00'], // banned owner's image
  ['Image', 61, 62, 'x', '08 01:00:00'], // new-account owner's image
  ['Article', 80, 63, 'x', '08 01:00:00'],
  // Owner 14: three images, 10 signed-out sessions each, no signed-in viewers.
  ...[101, 102, 103].flatMap((id) =>
    Array.from({ length: 10 }, (_, k) => ['Image', id, 0, `o${id}-${k}`, '08 01:00:00'])
  ),
];
const rx = [
  // type, entityId, userId, reaction, time
  ['Image_Create', 10, 50, 'Like', '08 05:00:00'],
  ['Image_Create', 10, 50, 'Heart', '08 06:00:00'],
  ['Image_Create', 10, 54, 'Like', '07 05:00:00'],
  ['Image_Create', 10, 55, 'Like', '08 05:00:00'],
  ['Image_Delete', 10, 55, 'Like', '08 07:00:00'],
  ['Image_Create', 10, 1, 'Like', '08 05:00:00'],
  ['Image_Create', 10, 51, 'Like', '08 05:00:00'],
  ['Image_Create', 11, 56, 'Like', '08 08:00:00'],
  ['Article_Create', 80, 63, 'Like', '08 02:00:00'],
];
// The affected user is targetUserId; userId is whoever acted (a moderator, or 0 at registration).
// Viewer 50 is a moderator who banned 52, and was once banned and unbanned themselves.
const ua = [
  // type, userId (actor), targetUserId, time
  ['Registration', 0, 51, '05 00:00:00'],
  ['Banned', 50, 52, '01 00:00:00'],
  ['Banned', 998, 50, '01 00:00:00'],
  ['Unbanned', 998, 50, '02 00:00:00'],
  ['Banned', 998, 11, '01 00:00:00'],
  ['Registration', 0, 12, '06 00:00:00'],
];
const pl = [
  // userId, cosmeticId, claimKey, team, entityType, entityId, entityOwnerId, startedAt, endedAt|null
  [1, 100, 'a', 'Yellow', 'Image', 10, 1, '07 00:00:00', null],
  // The same placement twice: a re-sent row before its ReplacingMergeTree merge. Must not double.
  [1, 100, 'a', 'Yellow', 'Image', 10, 1, '07 00:00:00', null],
  [1, 100, 'b', 'Yellow', 'Image', 11, 1, '08 12:00:00', null],
  [1, 100, 'g', 'Yellow', 'Image', 13, 1, '07 00:00:00', null],
  [2, 200, 'c', 'Blue', 'Image', 20, 3, '07 00:00:00', null],
  [4, 400, 'd', 'Pink', 'Image', 40, 4, '07 00:00:00', '08 06:00:00'],
  [4, 401, 'e', 'Pink', 'Image', 40, 4, '08 06:00:00', null],
  [7, 700, 'f', 'Green', 'Image', 12, 7, '07 00:00:00', null],
  [11, 1100, 'h', 'Blue', 'Image', 60, 11, '07 00:00:00', null],
  [12, 1200, 'i', 'Pink', 'Image', 61, 12, '07 00:00:00', null],
  [13, 1300, 'j', 'Green', 'Article', 80, 13, '07 00:00:00', null],
  [14, 1400, 'k', 'Blue', 'Image', 101, 14, '07 00:00:00', null],
  [14, 1400, 'l', 'Blue', 'Image', 102, 14, '07 00:00:00', null],
  [14, 1400, 'm', 'Blue', 'Image', 103, 14, '07 00:00:00', null],
];
const t = (s) => `'2026-10-${s}'`;
const fixtures = `WITH
  impressions AS (SELECT tupleElement(t,1) AS entityType, toInt32(tupleElement(t,2)) AS entityId, toInt32(tupleElement(t,3)) AS userId, tupleElement(t,4) AS sessionKey, toDateTime(tupleElement(t,5), 'UTC') AS time FROM (SELECT arrayJoin([${imp
    .map(([a, b, c, d, e]) => `('${a}', ${b}, ${c}, '${d}', ${t(e)})`)
    .join(',')}]) AS t)),
  reactions AS (SELECT tupleElement(t,1) AS type, toInt32(tupleElement(t,2)) AS entityId, toInt32(tupleElement(t,3)) AS userId, tupleElement(t,4) AS reaction, toDateTime(tupleElement(t,5), 'UTC') AS time FROM (SELECT arrayJoin([${rx
    .map(([a, b, c, d, e]) => `('${a}', ${b}, ${c}, '${d}', ${t(e)})`)
    .join(',')}]) AS t)),
  userActivities AS (SELECT tupleElement(t,1) AS type, toInt32(tupleElement(t,2)) AS userId, toInt32(tupleElement(t,3)) AS targetUserId, toDateTime(tupleElement(t,4), 'UTC') AS time FROM (SELECT arrayJoin([${ua
    .map(([a, b, c, d]) => `('${a}', ${b}, ${c}, ${t(d)})`)
    .join(',')}]) AS t)),
  event_cosmetic_placements AS (SELECT 'e' AS event, toInt32(tupleElement(t,1)) AS userId, toInt32(tupleElement(t,2)) AS cosmeticId, tupleElement(t,3) AS claimKey, tupleElement(t,4) AS team, tupleElement(t,5) AS entityType, toInt32(tupleElement(t,6)) AS entityId, toInt32(tupleElement(t,7)) AS entityOwnerId, toDateTime64(tupleElement(t,8), 3, 'UTC') AS startedAt, if(tupleElement(t,9) = '', NULL, toDateTime64(tupleElement(t,9), 3, 'UTC')) AS endedAt FROM (SELECT arrayJoin([${pl
    .map(
      ([a, b, c, d, e, f, g, h, i]) =>
        `(${a}, ${b}, '${c}', '${d}', '${e}', ${f}, ${g}, ${t(h)}, ${i ? t(i) : "''"})`
    )
    .join(',')}]) AS t)),`;
sql = fixtures + one(sql.trimStart(), 'WITH', '');

const params = {
  event: 'e',
  dayStart: '2026-10-08 00:00:00.000',
  dayEnd: '2026-10-09 00:00:00.000',
  eventStart: '2026-10-01 00:00:00.000',
  newAccountCutoff: '2026-10-01 00:00:00.000',
  botLimit: 3,
  viewerCap: 2,
  anonFloor: 10,
  anonRatio: 1.0,
};
const host = process.env.CLICKHOUSE_HOST;
const client = createClient({
  url: /^https?:\/\//.test(host) ? host : `https://${host}`,
  username: process.env.CLICKHOUSE_USERNAME,
  password: process.env.CLICKHOUSE_PASSWORD,
  clickhouse_settings: { readonly: '2' },
});
const rows = await (
  await client.query({ query: sql, query_params: params, format: 'JSONEachRow' })
).json();
await client.close();

const got = Object.fromEntries(
  rows.map((r) => [
    `${r.userId}:${r.cosmeticId}:${r.claimKey}:${r.team}`,
    [+r.impressions, +r.anonImpressions, +r.reactions],
  ])
);
const expected = {
  '1:100:a:Yellow': [2, 1, 1], // 10: viewers 50, 70 (dup/owner/new/banned out); anon s1 (bot out); reaction 50 only
  '1:100:b:Yellow': [2, 0, 0], // 11: 53 and 70 inside the interval; 50 and reactor 56 before it
  '4:400:d:Pink': [1, 0, 0], // 40 before 06:00: viewer 60
  '4:401:e:Pink': [1, 0, 0], // 40 after 06:00: viewer 61 only; 60 already credited today
  '7:700:f:Green': [1, 10, 0], // 12: one signed viewer; 15 anon capped at max(10, 1)
  '12:1200:i:Pink': [1, 0, 0], // a new account may still score as an OWNER (the rule is for viewers)
  '13:1300:j:Green': [1, 0, 1], // Article: one view, one reaction
  // Owner 14: 3 x 10 anon, each within its per-entity cap of 10, but the owner's daily cap is
  // max(10, 0 signed) = 10, so each cosmetic gets floor(10 x 10 / 30) = 3.
  '14:1400:k:Blue': [0, 3, 0],
  '14:1400:l:Blue': [0, 3, 0],
  '14:1400:m:Blue': [0, 3, 0],
  // 1:100:g (image 13): viewer 70 is over the per-owner cap of 2 -> nothing; 2:200:c: not owner's
  // content; 11:1100:h: banned owner.
};
const norm = (o) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(o)
        .filter(([, v]) => v.some(Boolean))
        .sort()
    )
  );
const ok = norm(got) === norm(expected);
console.log(ok ? 'MATCH' : `MISMATCH\n got      ${norm(got)}\n expected ${norm(expected)}`);
process.exit(ok ? 0 : 1);
