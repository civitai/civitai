import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildFeedEventRow } from '../feed-events.service';

// The insert skips unknown fields, so a row key the table lacks is dropped without a trace: the two
// are pinned. Columns come from the CREATE plus every later ADD COLUMN.
const MIGRATIONS = path.resolve(__dirname, '../../clickhouse/migrations');
const DDL = path.join(MIGRATIONS, '2026-11-20-feed-events.sql');
const ALTERS = readdirSync(MIGRATIONS).filter(
  (file) => /-feed-events[\w-]*\.sql$/.test(file) && file !== path.basename(DDL)
);

function ddlColumns(): string[] {
  const sql = readFileSync(DDL, 'utf8');
  const body = sql.slice(
    sql.indexOf('feedEvents\n(') + 'feedEvents\n('.length,
    sql.indexOf('\n)\nENGINE')
  );
  const added = ALTERS.flatMap((file) =>
    [
      ...readFileSync(path.join(MIGRATIONS, file), 'utf8').matchAll(
        /^\s*ADD COLUMN IF NOT EXISTS (\w+)/gm
      ),
    ].map((m) => m[1])
  );
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('--'))
    .map((l) => l.split(/\s+/)[0])
    .concat(added);
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
