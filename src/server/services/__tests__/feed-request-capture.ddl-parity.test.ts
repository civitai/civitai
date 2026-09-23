import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildFeedRequestRow } from '../feed-request-capture.service';

// TypeScript cannot check a row type against a ClickHouse DDL, and a drift 400s the
// whole batch into a swallowed catch — so the two are pinned to each other here.
const DDL = path.resolve(__dirname, '../../clickhouse/migrations/2026-09-04-feed-requests.sql');

function ddlColumns(): string[] {
  const sql = readFileSync(DDL, 'utf8');
  const body = sql.slice(
    sql.indexOf('feedRequests\n(') + 'feedRequests\n('.length,
    sql.indexOf('\n)\nENGINE')
  );
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('--'))
    .map((l) => l.split(/\s+/)[0]);
}

describe('feedRequests row ↔ DDL parity', () => {
  it('writes exactly the columns the table declares', () => {
    const columns = ddlColumns();
    const row = buildFeedRequestRow(
      {},
      { source: 'getImagesFromSearch', elapsedMs: 0, resultIds: [] },
      Date.UTC(2026, 8, 4),
      ''
    );
    expect(columns.length).toBeGreaterThan(20);
    expect(new Set(Object.keys(row))).toEqual(new Set(columns));
  });
});
