import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The sweep's hold is one NOT EXISTS over "Appeal". Which appeals hold a model back is a
// predicate on status and category together, so it runs here against real Postgres rather than
// being read off the statement's text.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

// Inlined as text literals: the statements bind their JSON keys untyped (`meta ? $1`), which the
// real driver sends as text but PGlite refuses to infer.
function run(strings: TemplateStringsArray, values: unknown[]) {
  const flat = Prisma.sql(strings, ...(values as never[]));
  const text = flat.text.replace(/\$(\d+)/g, (_, i: string) => {
    const value = flat.values[Number(i) - 1];
    return typeof value === 'number' ? String(value) : `'${String(value).replace(/'/g, "''")}'`;
  });
  return holder.db.query(text);
}

dbMock.dbWrite.$executeRaw.mockImplementation(
  (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    (await run(strings, values)).affectedRows ?? 0) as never
);
dbMock.dbRead.$queryRaw.mockImplementation(
  (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    (await run(strings, values)).rows) as never
);

const { acceptExpiredMinorAutoFlags, MINOR_HASH_ACCEPTED_KEY } = await import(
  '~/server/services/minor-hash.service'
);

// Flagged automatically well outside the review window, never accepted.
const EXPIRED_AUTO_FLAG = JSON.stringify({
  minorFlagSnapshot: { source: 'auto', at: '2020-01-01T00:00:00Z' },
});

beforeEach(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Model" (id INTEGER PRIMARY KEY, minor BOOLEAN NOT NULL, meta JSONB);
    CREATE TABLE "Appeal" (
      id SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
      status TEXT NOT NULL, category TEXT, context JSONB
    );
  `);
});

afterEach(async () => {
  await holder.db.close();
});

async function acceptedWith(
  dryRun: boolean,
  appeal: { status: string; category: string | null } | null
) {
  await holder.db.query(`INSERT INTO "Model" (id, minor, meta) VALUES (1, true, $1::jsonb)`, [
    EXPIRED_AUTO_FLAG,
  ]);
  if (appeal)
    await holder.db.query(
      `INSERT INTO "Appeal" ("entityType", "entityId", status, category) VALUES ('Model', 1, $1, $2)`,
      [appeal.status, appeal.category]
    );
  // A dry run counts what a real one would accept, from its own copy of the predicate.
  if (dryRun) return (await acceptExpiredMinorAutoFlags({ dryRun, limit: 10 })).accepted === 1;
  await acceptExpiredMinorAutoFlags({ dryRun, limit: 10 });
  const { rows } = await holder.db.query<{ accepted: boolean }>(
    `SELECT meta ? $1 AS accepted FROM "Model" WHERE id = 1`,
    [MINOR_HASH_ACCEPTED_KEY]
  );
  return rows[0].accepted;
}

describe.each([false, true])('acceptExpiredMinorAutoFlags, dryRun %s', (dryRun) => {
  it('accepts an expired auto flag nobody appealed', async () => {
    expect(await acceptedWith(dryRun, null)).toBe(true);
  });

  // A decided in-app appeal means a human already ruled on the flag.
  it.each(['Pending', 'Rejected', 'Approved', 'Void'])(
    'holds a model with an in-app appeal that is %s',
    async (status) => {
      expect(await acceptedWith(dryRun, { status, category: null })).toBe(false);
    }
  );

  it('holds a model while its site-form appeal is Pending', async () => {
    expect(await acceptedWith(dryRun, { status: 'Pending', category: 'Model' })).toBe(false);
  });

  // The form's Model queue rules on the unpublish, not the flag: once it decides, nothing about
  // the flag was reviewed, so it must not hold the flag out of the sweep for good.
  it.each(['Rejected', 'Approved', 'Void'])(
    'accepts once its site-form appeal is %s',
    async (status) => {
      expect(await acceptedWith(dryRun, { status, category: 'Model' })).toBe(true);
    }
  );
});
