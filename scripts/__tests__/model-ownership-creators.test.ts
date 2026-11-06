import { expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ClickhouseClient from '~/server/clickhouse/client';

/**
 * The creators query, as the script sends it. No ClickHouse runs in the unit suite, so this pins the
 * alias: `AS userId` shadows the column inside `anyIf(userId, … userId > 0)` and ClickHouse refuses
 * the query (code 184 ILLEGAL_AGGREGATION). The renamed query was run against the production
 * analytics replica before this test was written.
 */

const { query } = vi.hoisted(() => ({
  query: vi.fn(async (_sql: string) => [{ modelId: 11, creatorId: 7 }]),
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: { $query: query },
}));

it('selects the creator under an alias that is not a column, and prints it as the owner', async () => {
  dbMock.dbRead.model.findMany.mockResolvedValue([{ id: 11 }] as never);
  const printed: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    if (String(line).startsWith('INSERT')) printed.push(String(line));
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  await import('../oneoffs/model-ownership-creators');
  await vi.waitFor(() => expect(printed).toHaveLength(1));

  const sql = query.mock.calls[0][0];
  expect(sql).toMatch(/anyIf\(userId, type = 'Create' AND userId > 0\) AS creatorId/);
  expect(sql).not.toMatch(/AS userId\b/);
  expect(printed[0]).toContain(`SELECT 11, 7, 'baseline'`);
});
