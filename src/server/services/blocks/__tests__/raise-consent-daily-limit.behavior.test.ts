import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { raiseConsentDailyLimit } from '~/server/services/blocks/scope-grant.service';

// The in-app raise is one hand-written UPDATE that must never re-grant or un-revoke anything.
// This runs the statement the service builds against real Postgres, because only real SQL can
// show which rows it refuses and what it returns.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

dbMock.dbWrite.$queryRaw.mockImplementation((async (query: Prisma.Sql) => {
  const { rows } = await holder.db.query(query.text, query.values as unknown[]);
  return rows;
}) as never);

const SPEND = 'ai:write:budgeted';
const USER = 42;
const APP = 'apb_test';

async function grant(row: {
  budget: number | null;
  scopes?: string[];
  revokedScopes?: string[];
  revokedAt?: Date | null;
  userId?: number;
}) {
  await holder.db.query(
    `INSERT INTO app_user_scope_grants
       (id, user_id, app_block_id, version, granted_scopes, revoked_at, revoked_scopes, buzz_budget_per_day)
     VALUES ($1, $2, $3, '1', $4, $5, $6, $7)`,
    [
      `g_${row.userId ?? USER}`,
      row.userId ?? USER,
      APP,
      row.scopes ?? [SPEND],
      row.revokedAt ?? null,
      row.revokedScopes ?? [],
      row.budget,
    ]
  );
}

async function stored(userId = USER) {
  const { rows } = await holder.db.query<{
    buzz_budget_per_day: number | null;
    granted_scopes: string[];
    revoked_scopes: string[];
    revoked_at: Date | null;
  }>(
    `SELECT buzz_budget_per_day, granted_scopes, revoked_scopes, revoked_at
     FROM app_user_scope_grants WHERE user_id = $1`,
    [userId]
  );
  return rows[0];
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE app_user_scope_grants (
      id text PRIMARY KEY,
      user_id int NOT NULL,
      app_block_id text NOT NULL,
      version text NOT NULL,
      granted_scopes text[] NOT NULL DEFAULT '{}',
      granted_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      revoked_scopes text[] NOT NULL DEFAULT '{}',
      revoked_scopes_at timestamptz,
      buzz_budget_per_day int,
      UNIQUE (user_id, app_block_id)
    );
  `);
});
afterAll(() => holder.db.close());
beforeEach(async () => {
  await holder.db.exec('TRUNCATE app_user_scope_grants');
});

const raise = (buzzBudgetPerDay: number, userId = USER) =>
  raiseConsentDailyLimit({ userId, appBlockId: APP, buzzBudgetPerDay });

describe('raiseConsentDailyLimit', () => {
  it('raises a live limit and returns the one it replaced', async () => {
    await grant({ budget: 1000 });
    expect(await raise(2500)).toEqual({ previousLimit: 1000 });
    expect((await stored()).buzz_budget_per_day).toBe(2500);
  });

  it('touches nothing but the limit', async () => {
    await grant({ budget: 1000, scopes: [SPEND, 'user:read:self'], revokedScopes: ['x:y'] });
    await raise(2000);
    expect(await stored()).toMatchObject({
      granted_scopes: [SPEND, 'user:read:self'],
      revoked_scopes: ['x:y'],
      revoked_at: null,
    });
  });

  it.each([
    ['the spend scope is revoked', { budget: 1000, revokedScopes: [SPEND] }],
    ['the whole grant is revoked', { budget: 1000, revokedAt: new Date() }],
    ['spend was never granted', { budget: 1000, scopes: ['user:read:self'] }],
    ['no limit is set', { budget: null }],
  ])('refuses and writes nothing when %s', async (_label, row) => {
    await grant(row);
    const before = await stored();
    expect(await raise(5000)).toBeNull();
    expect(await stored()).toEqual(before);
  });

  it('refuses a value that is not higher', async () => {
    await grant({ budget: 1000 });
    expect(await raise(1000)).toBeNull();
    expect(await raise(500)).toBeNull();
    expect((await stored()).buzz_budget_per_day).toBe(1000);
  });

  it("never touches another viewer's grant", async () => {
    await grant({ budget: 1000, userId: 7 });
    expect(await raise(2000)).toBeNull();
    expect((await stored(7)).buzz_budget_per_day).toBe(1000);
  });
});
