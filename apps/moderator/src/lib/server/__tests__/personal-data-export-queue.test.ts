import { readFileSync } from 'fs';
import path from 'path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
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
 * The queue's ON CONFLICT must match the partial index the migration creates, or Postgres finds no
 * arbiter index and every queue fails. So the SQL the app compiles runs here against Postgres with
 * both migrations applied: the real index decides queued or already-queued, not a string compare.
 */

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../../../packages/civitai-db-schema/prisma/migrations'
);

const sent = vi.hoisted(() => ({
  pg: undefined as unknown as PGlite,
  queries: [] as CompiledQuery[],
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
        const r = await sent.pg.query(q.sql, q.parameters as unknown[]);
        return { rows: r.rows, numAffectedRows: BigInt(r.affectedRows ?? 0) } as never;
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
      await sent.pg.exec('BEGIN');
    },
    commitTransaction: async () => {
      sent.tx.push('commit');
      await sent.pg.exec('COMMIT');
    },
    rollbackTransaction: async () => {
      sent.tx.push('rollback');
      await sent.pg.exec('ROLLBACK');
    },
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

sent.pg = await freshPglite();
// Both migrations, in the order they are applied.
for (const dir of [
  '20261225120000_personal_data_export',
  '20261228120000_personal_data_export_request',
])
  await sent.pg.exec(readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
await sent.pg.exec(`
  CREATE TABLE "User" (id int PRIMARY KEY);
  CREATE TABLE "ModActivity" (id serial PRIMARY KEY, "userId" int, "entityType" text,
    "entityId" int, activity text, "createdAt" timestamp DEFAULT now());
  INSERT INTO "User" (id) VALUES (7);
`);
afterAll(() => sent.pg.close());

const { queuePersonalDataExport } = await import('../personal-data-export.service');

beforeEach(async () => {
  sent.queries = [];
  sent.tx = [];
  sent.on = [];
  sent.failAudit = false;
  await sent.pg.exec(`DELETE FROM "PersonalDataExport"; DELETE FROM "ModActivity";`);
});

const input = {
  userId: 7,
  requestedById: 4,
  ticketId: 555,
  requestedAt: new Date('2026-10-02T15:30:00Z'),
};

const exportsFor7 = async () =>
  (
    await sent.pg.query<{ status: string; ticketId: number; requestedAt: string }>(
      `SELECT status, "ticketId", "requestedAt"::text AS "requestedAt"
       FROM "PersonalDataExport" WHERE "userId" = 7 ORDER BY id`
    )
  ).rows;
const audits = async () =>
  (await sent.pg.query(`SELECT "userId", "entityType", "entityId", activity FROM "ModActivity"`))
    .rows;
const existing = (status: string) =>
  sent.pg.query(
    `INSERT INTO "PersonalDataExport" ("userId", "requestedById", status) VALUES (7, 4, $1)`,
    [status]
  );

describe('queuePersonalDataExport', () => {
  it('queues the export with its ticket and request day, and audits it, in one transaction', async () => {
    const result = await queuePersonalDataExport(input);
    expect(result).toEqual({ status: 'queued', id: expect.any(Number) });
    // The UTC day the user asked.
    expect(await exportsFor7()).toEqual([
      { status: 'queued', ticketId: 555, requestedAt: '2026-10-02' },
    ]);
    expect(await audits()).toEqual([
      { userId: 4, entityType: 'user', entityId: 7, activity: 'queuePersonalDataExport' },
    ]);
    expect(sent.tx).toEqual(['begin', 'commit']);
    // Both inserts ran on the transaction's own connection, not beside it.
    const conn = (re: RegExp) => sent.on[sent.queries.findIndex((q) => re.test(q.sql))];
    expect(conn(/^insert into "PersonalDataExport"/i)).toBe(sent.txConn);
    expect(conn(/^insert into "ModActivity"/i)).toBe(sent.txConn);
  });

  it.each(['queued', 'building'])(
    'answers already-queued while an export is %s, and adds and audits nothing',
    async (status) => {
      await existing(status);
      expect(await queuePersonalDataExport(input)).toEqual({ status: 'already-queued' });
      expect(await exportsFor7()).toHaveLength(1);
      expect(await audits()).toEqual([]);
    }
  );

  it.each(['built', 'held', 'failed'])(
    'queues a new export beside one that is %s (no longer in flight)',
    async (status) => {
      await existing(status);
      expect(await queuePersonalDataExport(input)).toMatchObject({ status: 'queued' });
      expect(await exportsFor7()).toHaveLength(2);
    }
  );

  it('queues nothing when the audit row cannot be written: both roll back together', async () => {
    sent.failAudit = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await queuePersonalDataExport(input)).toEqual({ status: 'error' });
    expect(sent.tx).toEqual(['begin', 'rollback']);
    expect(await exportsFor7()).toEqual([]);
    spy.mockRestore();
  });
});
