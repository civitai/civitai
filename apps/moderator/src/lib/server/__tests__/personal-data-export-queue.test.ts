import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
} from 'kysely';

/**
 * The queue's ON CONFLICT must name the same partial index the migration creates
 * (`"userId" WHERE status IN ('queued', 'building')`), or Postgres finds no arbiter index and every
 * queue fails. The SQL the app sends is captured here and compared against the index predicate.
 */

const sent = vi.hoisted(() => ({ queries: [] as CompiledQuery[], insertRows: [] as unknown[] }));
const audit = vi.hoisted(() => vi.fn());

vi.mock('../mod-activity', () => ({ recordModActivity: audit }));
vi.mock('../user-actions.service', () => ({ callModEndpoint: vi.fn() }));
vi.mock('../db', () => {
  const connection: DatabaseConnection = {
    async executeQuery(q) {
      sent.queries.push(q);
      if (/^select/i.test(q.sql)) return { rows: [{ id: 7 }] } as never;
      return { rows: sent.insertRows } as never;
    },
    async *streamQuery() {
      yield* [];
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<never>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { dbRead: db, dbWrite: db };
});

const { queuePersonalDataExport } = await import('../personal-data-export.service');

beforeEach(() => {
  sent.queries = [];
  audit.mockReset();
});

describe('queuePersonalDataExport', () => {
  it('inserts against the in-flight partial index and audits the queue', async () => {
    sent.insertRows = [{ id: 31 }];
    expect(await queuePersonalDataExport({ userId: 7, requestedById: 4 })).toEqual({
      status: 'queued',
      id: 31,
    });
    const insert = sent.queries.find((q) => /^insert/i.test(q.sql))!;
    expect(insert.sql.replace(/\s+/g, ' ')).toContain(
      `on conflict ("userId") where status IN ('queued', 'building') do nothing`
    );
    expect(audit).toHaveBeenCalledWith({
      userId: 4,
      entityType: 'user',
      entityId: 7,
      activity: 'queuePersonalDataExport',
    });
  });

  it('answers already-queued when the insert hit the index, and audits nothing', async () => {
    sent.insertRows = [];
    expect(await queuePersonalDataExport({ userId: 7, requestedById: 4 })).toEqual({
      status: 'already-queued',
    });
    expect(audit).not.toHaveBeenCalled();
  });
});
