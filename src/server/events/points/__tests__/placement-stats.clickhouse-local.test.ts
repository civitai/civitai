import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { hatPlacementStatsSql } from '~/server/events/points/placement-stats.sql';
import { totalPlacementRows } from '~/server/events/points/placement-stats.rows';
import { eventPointsRefereeSql } from '~/server/events/points/referee.sql';

// Runs the per-placement query and the referee on the same ledger rows in a real ClickHouse
// (clickhouse local), so the two are compared as executed SQL. Needs CLICKHOUSE_LOCAL_BIN (a
// `clickhouse` binary); without it the suite is skipped, which CI does.
const BIN = process.env.CLICKHOUSE_LOCAL_BIN;

const TABLE = `CREATE TABLE event_point_events (
  event LowCardinality(String), time DateTime64(3, 'UTC'), type LowCardinality(String),
  op Enum8('add' = 1, 'remove' = 2), actorId Int32, entityType LowCardinality(String),
  entityId Int32, ownerId Int32, cosmeticId Int32, claimKey String, team LowCardinality(String),
  sourceId String, players Array(Int32) DEFAULT []
) ENGINE = MergeTree ORDER BY (event, toDate(time), ownerId, actorId, type, entityType, entityId)`;

const U = 100;
type Row = {
  time: string;
  type: string;
  actor: number;
  entity: number;
  hat?: [number, string];
  op?: 'add' | 'remove';
  sourceId?: string;
  players?: number[];
};
// Test weights and limit, not the event's.
const CAP = 8;
const TYPES = ['view', 'reaction'];
const WEIGHTS = [1, 5];

const ledger: Row[] = [
  // Hat 1 on image 10 in an earlier stint, then on image 9 until 12:00, then on image 10 again.
  { time: '2026-11-01 07:00:00', type: 'view', actor: 209, entity: 10, hat: [1, 'k1'] },
  { time: '2026-11-01 10:00:00', type: 'view', actor: 201, entity: 9, hat: [1, 'k1'] },
  // 201 then fills the limit across hats: view 9 (1), view 10 (1), a reaction on hat 2's image 11
  // (5), and a reaction on 10 that gets the 1 left.
  { time: '2026-11-01 13:00:00', type: 'view', actor: 201, entity: 10, hat: [1, 'k1'] },
  { time: '2026-11-01 13:30:00', type: 'reaction', actor: 201, entity: 11, hat: [2, 'k2'] },
  { time: '2026-11-01 14:00:00', type: 'reaction', actor: 201, entity: 10, hat: [1, 'k1'] },
  // Next day the daily view counts again.
  { time: '2026-11-02 09:00:00', type: 'view', actor: 201, entity: 10, hat: [1, 'k1'] },
  // 203 spends 6 of the limit through a turf sticker naming U, so its reaction on 10 gets 2.
  { time: '2026-11-01 13:00:00', type: 'reaction', actor: 203, entity: 50, players: [U, 300] },
  { time: '2026-11-01 13:01:00', type: 'view', actor: 203, entity: 50, players: [U, 300] },
  { time: '2026-11-01 13:05:00', type: 'reaction', actor: 203, entity: 10, hat: [1, 'k1'] },
  // Past the limit, a view earns nothing and is not counted.
  { time: '2026-11-01 13:10:00', type: 'view', actor: 203, entity: 10, hat: [1, 'k1'] },
  // A hidden person: the referee drops them.
  { time: '2026-11-01 15:00:00', type: 'reaction', actor: 204, entity: 10, hat: [1, 'k1'] },
  // 206 reacted on 10 under hat 2 before hat 1 arrived; the season's first stays with hat 2.
  { time: '2026-11-01 08:00:00', type: 'reaction', actor: 206, entity: 10, hat: [2, 'k2'] },
  { time: '2026-11-01 16:00:00', type: 'reaction', actor: 206, entity: 10, hat: [1, 'k1'] },
  // 207 took their reaction back: it never scores.
  {
    time: '2026-11-01 16:00:00',
    type: 'reaction',
    actor: 207,
    entity: 10,
    hat: [1, 'k1'],
    sourceId: 'r:10:207',
  },
  {
    time: '2026-11-01 16:30:00',
    type: 'reaction',
    actor: 207,
    entity: 10,
    hat: [1, 'k1'],
    sourceId: 'r:10:207',
    op: 'remove',
  },
  // Hat 3 has been on image 12 all season.
  { time: '2026-11-01 11:00:00', type: 'view', actor: 208, entity: 12, hat: [3, 'k3'] },
  // 208 spends 5 on hat 2 between them, so that reaction gets the 2 left.
  { time: '2026-11-01 11:02:00', type: 'reaction', actor: 208, entity: 11, hat: [2, 'k2'] },
  { time: '2026-11-01 11:05:00', type: 'reaction', actor: 208, entity: 12, hat: [3, 'k3'] },
  { time: '2026-11-02 11:00:00', type: 'view', actor: 208, entity: 12, hat: [3, 'k3'] },
  { time: '2026-11-02 11:00:00', type: 'view', actor: 201, entity: 12, hat: [3, 'k3'] },
  // Someone else's hat: never read.
  {
    time: '2026-11-01 13:00:00',
    type: 'reaction',
    actor: 201,
    entity: 99,
    hat: [9, 'k9'],
    players: [],
  },
];

const sqlString = (s: string) => `'${s.replace(/'/g, "\\'")}'`;
function insert(rows: Row[]) {
  const values = rows.map((r) => {
    const owner = r.players ? (r.hat ? 999 : 0) : U;
    const [cosmeticId, claimKey] = r.hat ?? [77, 'turf'];
    return `('e', '${r.time}.000', '${r.type}', '${r.op ?? 'add'}', ${r.actor}, 'Image', ${
      r.entity
    }, ${owner}, ${cosmeticId}, ${sqlString(claimKey)}, 'red', ${sqlString(r.sourceId ?? '')}, [${(
      r.players ?? []
    ).join(',')}])`;
  });
  return `INSERT INTO event_point_events VALUES ${values.join(',\n')}`;
}

const arr = (xs: (string | number)[]) =>
  `[${xs.map((x) => (typeof x === 'string' ? sqlString(x) : x)).join(',')}]`;

function run(sql: string, params: Record<string, string>) {
  const out = execFileSync(
    BIN!,
    [
      'local',
      ...Object.entries(params).map(([k, v]) => `--param_${k}=${v}`),
      '--query',
      `${TABLE}; ${insert(ledger)}; ${sql} FORMAT JSONEachRow`,
    ],
    { encoding: 'utf8' }
  );
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const base = (recomputeFrom: string, restricted: number[]) => ({
  event: 'e',
  seasonStart: '2026-11-01 00:00:00.000',
  recomputeFrom,
  cut: '2026-11-03 00:00:00.000',
  removeCut: '2026-11-03 00:00:00.000',
  cap: String(CAP),
  types: arr(TYPES),
  weights: arr(WEIGHTS),
  dailyTypes: arr(['view']),
  restrictedUsers: arr(restricted),
  newAccountMinId: '2147483647',
});

function placementStats(placements: [number, string, number, string][]) {
  const earliest = placements.map((p) => p[3]).sort()[0];
  const rows = run(hatPlacementStatsSql, {
    ...base(`${earliest.slice(0, 10)} 00:00:00.000`, []),
    userId: String(U),
    placements: `[${placements
      .map(([c, k, e, t]) => `(${c},${sqlString(k)},'Image',${e},'${t}')`)
      .join(',')}]`,
  }).map((r) => ({
    cosmeticId: Number(r.cosmeticId),
    claimKey: String(r.claimKey),
    actorId: Number(r.actorId),
    hatPoints: Number(r.hatPoints),
    points: Number(r.points),
    views: Number(r.views),
  }));
  return totalPlacementRows(rows, { userId: U, hidden: [204], newAccountMinId: 2147483647 });
}

describe.skipIf(!BIN)('hat placement stats in ClickHouse', () => {
  it('counts what the hat earned on its image since it went on, shared limit and all', () => {
    const totals = placementStats([[1, 'k1', 10, '2026-11-01 12:00:00.000']]);
    // view 13:00 (1) + 201's reaction (1 left) + 203's reaction after turf (2) + day-2 view (1).
    expect(totals.get('1:k1')).toMatchObject({ points: 5, views: 2 });
  });

  it('never gives an image more than its hat earned over the same span', () => {
    const totals = placementStats([
      [1, 'k1', 10, '2026-11-01 12:00:00.000'],
      [3, 'k3', 12, '2026-11-01 00:00:00.000'],
    ]);
    for (const t of totals.values()) expect(t.points).toBeLessThanOrEqual(t.hatPoints);
  });

  it("matches the referee's own totals for a hat that never moved", () => {
    const referee = run(eventPointsRefereeSql, base('2026-11-01 00:00:00.000', [204]));
    const hat3 = referee.filter((r) => Number(r.cosmeticId) === 3);
    const points = hat3.reduce((s, r) => s + Number(r.points), 0);
    const views = hat3.reduce((s, r) => s + Number(r.views), 0);
    expect(points).toBeGreaterThan(0);
    expect(placementStats([[3, 'k3', 12, '2026-11-01 00:00:00.000']]).get('3:k3')).toMatchObject({
      points,
      views,
    });
  });
});
