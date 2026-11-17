import { PGlite } from '@electric-sql/pglite';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
} from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The opt-in is written and read by hand-built Kysely statements whose WHERE is the whole safety
// story (live grant, spend granted and unrevoked, the right limit state), so they run against
// real Postgres.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ kysely: null as unknown }));
vi.mock('~/server/db/kyselyDb', () => ({
  get kyselyRead() {
    return holder.kysely;
  },
  get kyselyWrite() {
    return holder.kysely;
  },
}));

const { optInConfirmWithinLimit, optOutConfirmWithinLimit, readConfirmWithinLimit } = await import(
  '~/server/services/blocks/scope-grant.service'
);

let pg: PGlite;
const dialect = (db: PGlite): Dialect => {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      const result = await db.query(compiled.sql, compiled.parameters as unknown[]);
      return { rows: result.rows as never[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const noop = async () => undefined;
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: noop,
      acquireConnection: async () => connection,
      beginTransaction: noop,
      commitTransaction: noop,
      rollbackTransaction: noop,
      releaseConnection: noop,
      destroy: noop,
    }),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
};

const SPEND = 'ai:write:budgeted';
const USER = 42;
const APP = 'apb_test';

const TABLE = `
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
    confirm_within_limit_max_job int,
    UNIQUE (user_id, app_block_id)
  );`;

async function grant(row: {
  budget: number | null;
  scopes?: string[];
  revokedScopes?: string[];
  revokedAt?: Date | null;
  userId?: number;
}) {
  await pg.query(
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
  const { rows } = await pg.query<{
    buzz_budget_per_day: number | null;
    confirm_within_limit_max_job: number | null;
    granted_scopes: string[];
    revoked_scopes: string[];
  }>(
    `SELECT buzz_budget_per_day, confirm_within_limit_max_job, granted_scopes, revoked_scopes
     FROM app_user_scope_grants WHERE user_id = $1`,
    [userId]
  );
  return rows[0];
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(TABLE);
  holder.kysely = new Kysely({ dialect: dialect(pg) });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec('TRUNCATE app_user_scope_grants');
});

describe('optInConfirmWithinLimit', () => {
  it('opts in a viewer who already has a limit, and changes nothing else', async () => {
    await grant({ budget: 2000, scopes: [SPEND, 'user:read:self'] });
    expect(await optInConfirmWithinLimit({ userId: USER, appBlockId: APP, maxJob: 1040 })).toEqual({
      limit: 2000,
    });
    expect(await stored()).toMatchObject({
      buzz_budget_per_day: 2000,
      confirm_within_limit_max_job: 1040,
      granted_scopes: [SPEND, 'user:read:self'],
      revoked_scopes: [],
    });
    expect(await readConfirmWithinLimit(USER, APP)).toBe(1040);
  });

  it('sets a limit and opts in, in one write, for a viewer with none', async () => {
    await grant({ budget: null });
    expect(
      await optInConfirmWithinLimit({ userId: USER, appBlockId: APP, maxJob: 1040, newLimit: 1500 })
    ).toEqual({ limit: 1500 });
    expect(await stored()).toMatchObject({
      buzz_budget_per_day: 1500,
      confirm_within_limit_max_job: 1040,
    });
  });

  it('a new limit never overwrites one that was set meanwhile', async () => {
    await grant({ budget: 800 });
    expect(
      await optInConfirmWithinLimit({ userId: USER, appBlockId: APP, maxJob: 1040, newLimit: 5000 })
    ).toBeNull();
    expect(await stored()).toMatchObject({
      buzz_budget_per_day: 800,
      confirm_within_limit_max_job: null,
    });
  });

  it('without a new limit, a viewer with no limit is not opted in', async () => {
    await grant({ budget: null });
    expect(
      await optInConfirmWithinLimit({ userId: USER, appBlockId: APP, maxJob: 1040 })
    ).toBeNull();
    expect((await stored()).confirm_within_limit_max_job).toBeNull();
  });

  it.each([
    ['the spend scope is revoked', { budget: 1000, revokedScopes: [SPEND] }],
    ['the whole grant is revoked', { budget: 1000, revokedAt: new Date() }],
    ['spend was never granted', { budget: 1000, scopes: ['user:read:self'] }],
    ['the stored limit is 0', { budget: 0 }],
  ])('refuses and writes nothing when %s', async (_label, row) => {
    await grant(row);
    const before = await stored();
    expect(
      await optInConfirmWithinLimit({ userId: USER, appBlockId: APP, maxJob: 1040 })
    ).toBeNull();
    expect(await stored()).toEqual(before);
  });

  it('the switch-off clears it, and the viewer reads as not opted in', async () => {
    await grant({ budget: 2000 });
    await optInConfirmWithinLimit({ userId: USER, appBlockId: APP, maxJob: 1040 });
    await optOutConfirmWithinLimit(USER, APP);
    expect(await readConfirmWithinLimit(USER, APP)).toBeNull();
  });

  it("never touches another viewer's grant", async () => {
    await grant({ budget: 1000, userId: 7 });
    expect(
      await optInConfirmWithinLimit({ userId: USER, appBlockId: APP, maxJob: 1040 })
    ).toBeNull();
    expect((await stored(7)).confirm_within_limit_max_job).toBeNull();
  });
});

describe('a database without the column', () => {
  beforeAll(async () => {
    await pg.exec('ALTER TABLE app_user_scope_grants DROP COLUMN confirm_within_limit_max_job');
  });
  afterAll(async () => {
    await pg.exec('ALTER TABLE app_user_scope_grants ADD COLUMN confirm_within_limit_max_job int');
  });

  it('reads every viewer as not opted in', async () => {
    await grant({ budget: 1000 });
    expect(await readConfirmWithinLimit(USER, APP)).toBeNull();
  });

  it('switching off is a no-op, not an error', async () => {
    await grant({ budget: 1000 });
    await expect(optOutConfirmWithinLimit(USER, APP)).resolves.toBeUndefined();
  });

  it('opting in writes nothing and reports it', async () => {
    await grant({ budget: 1000 });
    expect(
      await optInConfirmWithinLimit({ userId: USER, appBlockId: APP, maxJob: 1040 })
    ).toBeNull();
  });
});
