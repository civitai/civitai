import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@civitai/db-schema';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The pool's connection hands cancellableQuery's text and params to PGlite, so Postgres itself parses
// what a Prisma.Sql param becomes on the wire.

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock('pg', () => {
  class FakePool {
    on() {}
    connect() {
      return Promise.resolve({
        processID: 1,
        query: (text: string, params?: unknown[]) => h.db.query(text, params),
        release: () => {},
      });
    }
  }
  class FakeClient {}
  const types = { setTypeParser: () => {}, builtins: { TIMESTAMP: 1114 } };
  return { Pool: FakePool, Client: FakeClient, types };
});

import { createPool, templateHandler } from './db-helpers';

const pool = createPool({ connectionString: 'postgresql://u:p@localhost:5432/test', ssl: false });

async function ids(sql: Prisma.Sql) {
  const rows = await (await pool.cancellableQuery<{ id: number }>(sql)).result();
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

beforeAll(async () => {
  h.db = new PGlite();
  await h.db.exec(`
    CREATE TABLE t (id int PRIMARY KEY, at timestamp);
    INSERT INTO t VALUES (1, '2026-01-01'), (2, '2026-02-01'), (3, '2026-03-01');
  `);
});

describe('cancellableQuery with a Prisma.Sql array param', () => {
  it('matches = ANY(...::int[])', async () => {
    expect(await ids(Prisma.sql`SELECT id FROM t WHERE id = ANY(${[1, 3]}::int[])`)).toEqual([
      1, 3,
    ]);
  });

  it('excludes with != ALL(...::int[]), one id or several', async () => {
    expect(await ids(Prisma.sql`SELECT id FROM t WHERE id != ALL(${[2]}::int[])`)).toEqual([1, 3]);
    expect(await ids(Prisma.sql`SELECT id FROM t WHERE id != ALL(${[1, 2]}::int[])`)).toEqual([3]);
  });

  it('still binds a Date and a scalar', async () => {
    const after = new Date('2026-01-15T00:00:00Z');
    expect(await ids(Prisma.sql`SELECT id FROM t WHERE at > ${after} AND id <> ${3}`)).toEqual([2]);
  });

  it('leaves the caller’s Prisma.Sql values untouched', async () => {
    const list = [1, 2];
    const sql = Prisma.sql`SELECT id FROM t WHERE id = ANY(${list}::int[])`;
    await ids(sql);
    expect(sql.values).toEqual([[1, 2]]);
  });
});

// templateHandler inlines values into the SQL text (the metrics queries' `IN (${ids})`), so it keeps
// joining arrays.
describe('templateHandler', () => {
  it('inlines an array as a comma list', async () => {
    const sql = templateHandler((text) => text)`SELECT id FROM t WHERE id IN (${[1, 3]})`;
    expect(sql).toBe('SELECT id FROM t WHERE id IN (1,3)');
    expect((await h.db.query<{ id: number }>(sql)).rows.map((r) => r.id)).toEqual([1, 3]);
  });
});
