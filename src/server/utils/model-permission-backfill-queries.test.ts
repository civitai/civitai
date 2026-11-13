import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  dollarQuery: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { query: mocks.query, $query: mocks.dollarQuery },
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

import handler from '~/pages/api/admin/temp/backfill-model-permission-snapshots';
import {
  PERMISSION_FIELDS,
  modelEventsQuery,
  modelIdsQuery,
} from '~/server/utils/model-permission-backfill-queries';

const json = (rows: unknown[]) => ({ json: async () => rows });

function makeRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res;
}

describe('model permission backfill queries', () => {
  it('binds the field names as string values, never as identifiers', () => {
    const { query, query_params } = modelIdsQuery({
      before: new Date('2026-10-15T14:15:05.130Z'),
      afterId: 7,
      batchSize: 500,
    });
    expect(query).toContain('field IN {fields:Array(String)}');
    expect(query).not.toMatch(/allowNoCredit|\$\{/);
    expect(query_params).toEqual({
      fields: [...PERMISSION_FIELDS],
      before: '2026-10-15 14:15:05.130',
      afterId: 7,
      batchSize: 500,
    });
  });

  it('binds the ids and field names for the events query', () => {
    const { query, query_params } = modelEventsQuery([3, 9]);
    expect(query).toContain('entityId IN {ids:Array(UInt64)}');
    expect(query).toContain('field IN {fields:Array(String)}');
    expect(query).not.toMatch(/allowNoCredit|\$\{/);
    expect(query_params).toEqual({ ids: [3, 9], fields: [...PERMISSION_FIELDS] });
  });

  describe('route', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      dbMock.dbRead.modelPermissionSnapshot.findFirst.mockResolvedValue({
        effectiveAt: new Date('2026-10-15T14:15:05.130Z'),
      });
      dbMock.dbRead.model.findMany.mockResolvedValue([]);
    });

    it('sends both ClickHouse queries through query() with bound params, not $query', async () => {
      mocks.query.mockResolvedValueOnce(json([{ entityId: 5 }])).mockResolvedValueOnce(json([]));
      const res = makeRes();
      await (handler as any)({ method: 'GET', query: { batchSize: '10', afterId: '2' } }, res);

      expect(res.statusCode).toBe(200);
      expect(mocks.dollarQuery).not.toHaveBeenCalled();
      expect(mocks.query).toHaveBeenCalledTimes(2);
      const [first, second] = mocks.query.mock.calls.map((c) => c[0]);
      expect(first.format).toBe('JSONEachRow');
      expect(first.query_params).toEqual({
        fields: [...PERMISSION_FIELDS],
        before: '2026-10-15 14:15:05.130',
        afterId: 2,
        batchSize: 10,
      });
      expect(second.query_params).toEqual({ ids: [5], fields: [...PERMISSION_FIELDS] });
    });
  });
});
