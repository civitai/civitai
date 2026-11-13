import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildAppBlockEventRow, classifyBlockEvent } from '../block-event-ingest.service';
import type { ApprovedEventDeclarations } from '../known-app-blocks.service';

// TypeScript cannot check a row against a ClickHouse DDL, and the insert does not wait for the
// server, so a renamed or retyped column loses rows without an error anywhere. The row the ingest
// builds is pinned to the migration here, by name AND by type, in both directions.
const DDL = path.resolve(
  __dirname,
  '../../../clickhouse/migrations/2026-10-10-app-block-events.sql'
);

function ddlColumns(): Array<{ name: string; type: string }> {
  const sql = readFileSync(DDL, 'utf8');
  const open = 'default.appBlockEvents\n(';
  const start = sql.indexOf(open);
  const end = sql.indexOf('\n)\nENGINE');
  expect(start, 'CREATE TABLE header not found').toBeGreaterThan(-1);
  expect(end, 'column list end not found').toBeGreaterThan(start);
  return sql
    .slice(start + open.length, end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('--'))
    .map((line) => {
      const [name, ...rest] = line.replace(/,$/, '').split(/\s+/);
      return { name, type: rest.join(' ') };
    });
}

const isString = (v: unknown) => typeof v === 'string';
const isBit = (v: unknown) => v === 0 || v === 1;
const isMapOf = (check: (v: unknown) => boolean) => (v: unknown) =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).length > 0 &&
  Object.values(v).every(check);

/** What a JSONEachRow value must look like for each column type the table uses. */
const WIRE_SHAPE: Record<string, (v: unknown) => boolean> = {
  'DateTime64(3)': (v) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(v),
  String: isString,
  'LowCardinality(String)': isString,
  Int32: (v) => Number.isInteger(v) && (v as number) >= -(2 ** 31) && (v as number) < 2 ** 31,
  // A decimal STRING: a JSON number above 2^53 is rounded before it reaches the column.
  UInt64: (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v),
  UInt8: isBit,
  'Map(LowCardinality(String), LowCardinality(String))': isMapOf(isString),
  'Map(LowCardinality(String), Float64)': isMapOf(
    (v) => typeof v === 'number' && Number.isFinite(v)
  ),
  'Map(LowCardinality(String), UInt8)': isMapOf(isBit),
};

const declarations: ApprovedEventDeclarations = new Map([
  [
    'level_cleared',
    new Map([
      ['difficulty', { type: 'enum', values: new Set(['calm', 'brutal']) }],
      ['seconds', { type: 'number' }],
      ['assisted', { type: 'boolean' }],
    ] as const),
  ],
]);

function fullRow() {
  // Every map populated, so each Map column's value type is exercised rather than vacuously met.
  const classified = classifyBlockEvent(declarations, 'level_cleared', {
    difficulty: 'brutal',
    seconds: 41.5,
    assisted: true,
  });
  return buildAppBlockEventRow({
    nowMs: Date.UTC(2031, 2, 14, 9, 8, 7, 65),
    appBlockId: 'apb_parity',
    blockInstanceId: 'page_apb_parity',
    classified,
    userId: 7301,
    viewerKey: '7552154172047254112',
    isOwner: true,
  });
}

describe('appBlockEvents row ↔ DDL parity', () => {
  it('reads the column list the migration declares', () => {
    // Pinned so a parser that silently reads nothing cannot make the comparisons below pass.
    expect(ddlColumns()).toEqual([
      { name: 'time', type: 'DateTime64(3)' },
      { name: 'appBlockId', type: 'String' },
      { name: 'blockInstanceId', type: 'String' },
      { name: 'eventName', type: 'LowCardinality(String)' },
      { name: 'userId', type: 'Int32' },
      { name: 'viewerKey', type: 'UInt64' },
      { name: 'isAnon', type: 'UInt8' },
      { name: 'isOwner', type: 'UInt8' },
      { name: 'enumProps', type: 'Map(LowCardinality(String), LowCardinality(String))' },
      { name: 'numProps', type: 'Map(LowCardinality(String), Float64)' },
      { name: 'boolProps', type: 'Map(LowCardinality(String), UInt8)' },
    ]);
  });

  it('writes exactly the columns the table declares', () => {
    expect(Object.keys(fullRow()).sort()).toEqual(
      ddlColumns()
        .map((c) => c.name)
        .sort()
    );
  });

  it('writes each column in a shape its DDL type accepts', () => {
    const row = fullRow() as Record<string, unknown>;
    for (const { name, type } of ddlColumns()) {
      const check = WIRE_SHAPE[type];
      expect(check, `no wire shape known for ${name} ${type}`).toBeTypeOf('function');
      expect(check(row[name]), `${name} = ${JSON.stringify(row[name])} is not a ${type}`).toBe(
        true
      );
    }
  });

  it('writes the literal values the fixture should produce', () => {
    expect(fullRow()).toEqual({
      time: '2031-03-14 09:08:07.065',
      appBlockId: 'apb_parity',
      blockInstanceId: 'page_apb_parity',
      eventName: 'level_cleared',
      userId: 7301,
      viewerKey: '7552154172047254112',
      isAnon: 0,
      isOwner: 1,
      enumProps: { difficulty: 'brutal' },
      numProps: { seconds: 41.5 },
      boolProps: { assisted: 1 },
    });
  });

  it('a signed-out row is userId 0, isAnon 1', () => {
    const row = buildAppBlockEventRow({
      nowMs: Date.UTC(2031, 2, 14),
      appBlockId: 'apb_parity',
      blockInstanceId: 'page_apb_parity',
      classified: classifyBlockEvent(declarations, 'level_cleared', {}),
      userId: null,
      viewerKey: '830607531308821364',
      isOwner: false,
    });
    expect(row).toMatchObject({ userId: 0, isAnon: 1, isOwner: 0 });
    expect(row).toMatchObject({ enumProps: {}, numProps: {}, boolProps: {} });
  });
});
