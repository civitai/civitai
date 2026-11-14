import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { hatPlacementViewsSql } from '~/server/events/points/placement-stats.sql';

// Runs the per-placement views query in a real ClickHouse (clickhouse local). Needs
// CLICKHOUSE_LOCAL_BIN (a `clickhouse` binary). CI does not set it, so CI skips this file.
const BIN = process.env.CLICKHOUSE_LOCAL_BIN;

const TABLE = `CREATE TABLE event_point_events (
  event LowCardinality(String), time DateTime64(3, 'UTC'), type LowCardinality(String),
  op Enum8('add' = 1, 'remove' = 2), actorId Int32, entityType LowCardinality(String),
  entityId Int32, ownerId Int32, cosmeticId Int32, claimKey String, team LowCardinality(String),
  sourceId String, players Array(Int32) DEFAULT []
) ENGINE = MergeTree ORDER BY (event, toDate(time), ownerId, actorId, type, entityType, entityId)`;

const U = 100;
type Row = [
  time: string,
  type: string,
  actor: number,
  entity: number,
  hat: [number, string],
  owner?: number
];
const ledger: Row[] = [
  // Hat 1: on image 10 earlier, then image 9, then image 10 again from 12:00.
  ['2026-11-01 07:00:00', 'view', 201, 10, [1, 'k1']],
  ['2026-11-01 10:00:00', 'view', 202, 9, [1, 'k1']],
  ['2026-11-01 13:00:00', 'view', 203, 10, [1, 'k1']],
  ['2026-11-02 09:00:00', 'view', 203, 10, [1, 'k1']],
  // Not views, or the owner's own.
  ['2026-11-01 13:30:00', 'reaction', 204, 10, [1, 'k1']],
  ['2026-11-01 14:00:00', 'view', U, 10, [1, 'k1']],
  // Hat 2 on image 11 all along; one view of 10 recorded under hat 2 in a race does not count for 1.
  ['2026-11-01 11:00:00', 'view', 205, 11, [2, 'k2']],
  ['2026-11-01 15:00:00', 'view', 206, 10, [2, 'k2']],
  // Hat 3 moved from image 30 to 31 at 12:00, but both placements are still open.
  ['2026-11-01 11:00:00', 'view', 208, 30, [3, 'k3']],
  ['2026-11-01 13:00:00', 'view', 208, 30, [3, 'k3']],
  ['2026-11-01 13:00:00', 'view', 209, 31, [3, 'k3']],
  // Someone else's hat and rows.
  ['2026-11-01 13:00:00', 'view', 207, 10, [1, 'k1'], 999],
];

const q = (s: string) => `'${s}'`;
const insert = `INSERT INTO event_point_events VALUES ${ledger
  .map(
    ([time, type, actor, entity, [c, k], owner]) =>
      `('e', '${time}.000', '${type}', 'add', ${actor}, 'Image', ${entity}, ${
        owner ?? U
      }, ${c}, ${q(k)}, 'red', '', [])`
  )
  .join(',')}`;

function views(placements: [number, string, number, string][]) {
  const out = execFileSync(
    BIN!,
    [
      'local',
      '--param_event=e',
      `--param_userId=${U}`,
      `--param_from=${placements.map((p) => p[3]).sort()[0]}`,
      '--param_to=2026-11-03 00:00:00.000',
      `--param_placements=[${placements
        .map(([c, k, e, t]) => `(${c},${q(k)},'Image',${e},'${t}')`)
        .join(',')}]`,
      '--query',
      `${TABLE}; ${insert}; ${hatPlacementViewsSql} FORMAT JSONEachRow`,
    ],
    { encoding: 'utf8' }
  );
  return Object.fromEntries(
    out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { cosmeticId: number; claimKey: string; views: string })
      .map((r) => [`${r.cosmeticId}:${r.claimKey}`, Number(r.views)])
  );
}

describe.skipIf(!BIN)('hat placement views in ClickHouse', () => {
  it("counts other people's views of the hat's image since it went on", () => {
    expect(
      views([
        [1, 'k1', 10, '2026-11-01 12:00:00.000'],
        [2, 'k2', 11, '2026-11-01 00:00:00.000'],
      ])
    ).toEqual({ '1:k1': 2, '2:k2': 1 });
  });

  it('counts only the latest of two open placements of one hat', () => {
    expect(
      views([
        [3, 'k3', 30, '2026-11-01 00:00:00.000'],
        [3, 'k3', 31, '2026-11-01 12:00:00.000'],
      ])
    ).toEqual({ '3:k3': 1 });
  });
});
