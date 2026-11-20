import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildFeedEventRow } from '../feed-events.service';

// A row key the table lacks fails the whole insert inside a swallowed catch, so the two are pinned.
const DDL = path.resolve(__dirname, '../../clickhouse/migrations/2026-11-20-feed-events.sql');

function ddlColumns(): string[] {
  const sql = readFileSync(DDL, 'utf8');
  const body = sql.slice(
    sql.indexOf('feedEvents\n(') + 'feedEvents\n('.length,
    sql.indexOf('\n)\nENGINE')
  );
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('--'))
    .map((l) => l.split(/\s+/)[0]);
}

describe('feedEvents row ↔ DDL parity', () => {
  it('writes exactly the columns the table declares', () => {
    const columns = ddlColumns();
    const row = buildFeedEventRow(
      {
        event: 'load',
        sessionKey: 's',
        feed: 'models',
        page: '/models',
        sort: '',
        pageIndex: 0,
        filters: {},
      },
      { userId: 0, memberType: 'undefined' },
      Date.UTC(2026, 10, 20)
    );
    expect(columns.length).toBeGreaterThan(10);
    expect(new Set(Object.keys(row))).toEqual(new Set(columns));
  });
});
