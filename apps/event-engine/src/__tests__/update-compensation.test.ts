import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

test('update-compensation writes to the configured metric events table', async () => {
  vi.stubEnv('CLICKHOUSE_METRIC_EVENTS_TABLE', 'entityMetricEvents_month');
  const { updateCompensation } = await import('@/handlers/manual/update-compensation');

  const queries: string[] = [];
  const insertTables: string[] = [];
  const ch = {
    query: async (sql: string) => {
      queries.push(sql);
      return [
        {
          entity: 'ModelVersion',
          entityId: 11,
          userId: 0,
          metricType: 'earnedAmount',
          metricValue: 5,
        },
      ];
    },
    insert: async (table: string) => {
      insertTables.push(table);
    },
  };
  const pg = { query: async () => [{ modelVersionId: 11, modelId: 7 }] };
  const actions = { incMetricCache: () => undefined };

  await updateCompensation.process({ data: { date: '2026-11-02' }, ch, pg, actions } as never);

  const insertSql = queries.find((q) => q.includes('INSERT INTO'));
  expect(insertSql).toMatch(/INSERT INTO entityMetricEvents_month\s/);
  expect(insertTables).toEqual(['entityMetricEvents_month']);
});
