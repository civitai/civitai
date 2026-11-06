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

const sent = vi.hoisted(() => ({
  queries: [] as CompiledQuery[],
  insertRows: [] as unknown[],
  failAudit: false,
  tx: [] as string[],
  on: [] as number[],
  txConn: 0,
}));

vi.mock('../user-actions.service', () => ({ callModEndpoint: vi.fn() }));
vi.mock('../db', () => {
  let next = 0;
  const connect = (): DatabaseConnection & { id: number } => {
    const id = ++next;
    return {
      id,
      async executeQuery(q) {
        sent.queries.push(q);
        sent.on.push(id);
        if (sent.failAudit && /^insert into "ModActivity"/i.test(q.sql))
          throw new Error('audit down');
        if (/^select/i.test(q.sql)) return { rows: [{ id: 7 }] } as never;
        return { rows: sent.insertRows } as never;
      },
      async *streamQuery() {
        yield* [];
      },
    };
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connect(),
    beginTransaction: async (c) => {
      sent.tx.push('begin');
      sent.txConn = (c as unknown as { id: number }).id;
    },
    commitTransaction: async () => void sent.tx.push('commit'),
    rollbackTransaction: async () => void sent.tx.push('rollback'),
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
  sent.tx = [];
  sent.on = [];
  sent.failAudit = false;
});

describe('queuePersonalDataExport', () => {
  it('inserts against the in-flight partial index and audits the queue', async () => {
    sent.insertRows = [{ id: 31 }];
    expect(await queuePersonalDataExport({ userId: 7, requestedById: 4 })).toEqual({
      status: 'queued',
      id: 31,
    });
    const insert = sent.queries.find((q) => /^insert into "PersonalDataExport"/i.test(q.sql))!;
    expect(insert.sql.replace(/\s+/g, ' ')).toContain(
      `on conflict ("userId") where status IN ('queued', 'building') do nothing`
    );
    const auditRow = sent.queries.find((q) => /^insert into "ModActivity"/i.test(q.sql))!;
    expect(auditRow.parameters).toEqual(
      expect.arrayContaining([4, 'user', 7, 'queuePersonalDataExport'])
    );
    expect(sent.tx).toEqual(['begin', 'commit']);
    // Both inserts ran on the transaction's own connection, not beside it.
    const conn = (re: RegExp) => sent.on[sent.queries.findIndex((q) => re.test(q.sql))];
    expect(conn(/^insert into "PersonalDataExport"/i)).toBe(sent.txConn);
    expect(conn(/^insert into "ModActivity"/i)).toBe(sent.txConn);
  });

  it('queues nothing when the audit row cannot be written: both roll back together', async () => {
    sent.insertRows = [{ id: 33 }];
    sent.failAudit = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await queuePersonalDataExport({ userId: 7, requestedById: 4 })).toEqual({
      status: 'error',
    });
    expect(sent.tx).toEqual(['begin', 'rollback']);
    spy.mockRestore();
  });

  it('answers already-queued when the insert hit the index, and audits nothing', async () => {
    sent.insertRows = [];
    expect(await queuePersonalDataExport({ userId: 7, requestedById: 4 })).toEqual({
      status: 'already-queued',
    });
    expect(sent.queries.some((q) => /^insert into "ModActivity"/i.test(q.sql))).toBe(false);
  });
});
