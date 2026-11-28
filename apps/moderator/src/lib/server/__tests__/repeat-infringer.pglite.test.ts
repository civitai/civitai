import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The repeat-infringer queue is derived from Copyright strikes: no flag is stored that escalation could
 * clear. Each seeded account is in or out for exactly one reason.
 */

const { dbHandle, addUserNote } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  addUserNote: vi.fn(),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
// User notes live in the moderator database, a separate store.
vi.mock('$lib/server/moderation-memory.service', () => ({ addUserNote }));
// The page's other actions call the main app; none of them runs here.
vi.mock('$lib/server/user-actions.service', () => ({
  setBanned: vi.fn(),
  setMuted: vi.fn(),
  voidStrike: vi.fn(),
  banConfirmed: vi.fn(),
}));

const {
  countRepeatInfringerReview,
  getRepeatInfringerQueue,
  isInRepeatInfringerReview,
  REPEAT_INFRINGER_THRESHOLD,
  REPEAT_INFRINGER_WINDOW_MONTHS,
} = await import('../repeat-infringer.service');
const { actions } = await import('../../../routes/users/strike-review/+page.server');

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(
  HERE,
  '../../../../../../packages/civitai-db-schema/prisma/migrations/20261128160000_user_strike_copyright_idx/migration.sql'
);

const SCHEMA = `
CREATE TABLE "User" (
  "id" INTEGER PRIMARY KEY,
  "username" TEXT,
  "meta" JSONB,
  "muted" BOOLEAN NOT NULL DEFAULT FALSE,
  "bannedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3)
);
CREATE TABLE "UserStrike" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Active',
  "points" INTEGER NOT NULL DEFAULT 0,
  "description" TEXT NOT NULL DEFAULT 'Back-recorded: copyright removal x (repeat-infringer ledger)',
  "internalNotes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT now() + interval '30 days',
  "voidedAt" TIMESTAMP(3)
);
`;

let db: PGlite;

const user = (id: number, extra: { meta?: object; bannedAt?: string } = {}) =>
  db.query(`INSERT INTO "User" ("id", "username", "meta", "bannedAt") VALUES ($1, $2, $3, $4)`, [
    id,
    `u${id}`,
    extra.meta ? JSON.stringify(extra.meta) : null,
    extra.bannedAt ?? null,
  ]);

/** Copyright removal events, `daysAgo` each. */
const copyright = async (userId: number, daysAgo: number[], status = 'Active') => {
  for (const d of daysAgo)
    await db.query(
      `INSERT INTO "UserStrike" ("userId", "reason", "status", "createdAt", "expiresAt", "voidedAt")
       VALUES ($1, 'Copyright', $2, now() - make_interval(days => $3), now() - make_interval(days => $3), $4)`,
      [userId, status, d, status === 'Voided' ? new Date() : null]
    );
};

beforeEach(async () => {
  vi.resetAllMocks();
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const queued = async () => (await getRepeatInfringerQueue()).rows.map((r) => r.userId);

describe('repeat-infringer queue', () => {
  it('is policy A: 3 removals in 12 months', () => {
    expect(REPEAT_INFRINGER_THRESHOLD).toBe(3);
    expect(REPEAT_INFRINGER_WINDOW_MONTHS).toBe(12);
  });

  it('queues the 3rd Copyright removal in the window, not the 2nd', async () => {
    await user(1);
    await user(2);
    await copyright(1, [200, 100, 1]);
    await copyright(2, [100, 1]);

    expect(await queued()).toEqual([1]);
    expect(await countRepeatInfringerReview()).toBe(1);
    expect(await isInRepeatInfringerReview(2)).toBe(false);
  });

  it('counts back-recorded rows: Expired at 0 points', async () => {
    await user(1);
    await copyright(1, [12, 11, 10], 'Expired');

    const { rows } = await getRepeatInfringerQueue();
    expect(rows.map((r) => [r.userId, r.eventCount])).toEqual([[1, 3]]);
    expect(rows[0].events).toHaveLength(3);
  });

  it('does not count a voided removal (a reversed takedown)', async () => {
    await user(1);
    await copyright(1, [30, 20]);
    await copyright(1, [10], 'Voided');

    expect(await queued()).toEqual([]);
  });

  it('drops a removal once it leaves the 12-month window, and counts one just inside it', async () => {
    await user(1);
    await user(2);
    await copyright(1, [370, 20, 10]);
    await copyright(2, [360, 20, 10]);

    expect(await queued()).toEqual([2]);
  });

  it('ignores other strike reasons', async () => {
    await user(1);
    await copyright(1, [20, 10]);
    await db.exec(
      `INSERT INTO "UserStrike" ("userId", "reason", "points") VALUES (1, 'TOSViolation', 3)`
    );

    expect(await queued()).toEqual([]);
  });

  it('stays queued through a later strike, a void of another strike, and expiry', async () => {
    await user(1);
    await copyright(1, [30, 20, 10]);
    await db.exec(`
      INSERT INTO "UserStrike" ("userId", "reason", "points") VALUES (1, 'TOSViolation', 1);
      INSERT INTO "UserStrike" ("userId", "reason", "points", "status", "voidedAt") VALUES (1, 'TOSViolation', 1, 'Voided', now());
      UPDATE "UserStrike" SET "status" = 'Expired' WHERE "userId" = 1 AND "reason" = 'Copyright';
    `);

    expect(await queued()).toEqual([1]);
  });

  it('leaves out banned accounts', async () => {
    await user(1, { bannedAt: '2026-11-01' });
    await copyright(1, [30, 20, 10]);

    expect(await queued()).toEqual([]);
  });

  it('leaves a reviewed account out until a new removal lands after the review', async () => {
    const reviewedAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
    await user(1, { meta: { repeatInfringerReview: { reviewedAt, reviewedBy: 42 } } });
    await copyright(1, [30, 20, 10]);
    expect(await queued()).toEqual([]);

    await copyright(1, [1]);
    expect(await queued()).toEqual([1]);
  });

  it.each([
    ['a non-timestamp string', 'soon'],
    ['a number', 12345],
    ['an object', { at: 'x' }],
    ['a date-only string', '2099-01-01'],
  ])('reads %s in reviewedAt as unreviewed, without failing the query', async (_label, value) => {
    await user(1, { meta: { repeatInfringerReview: { reviewedAt: value } } });
    await user(2);
    await copyright(1, [30, 20, 10]);
    await copyright(2, [30, 20, 10]);

    expect(await queued()).toEqual([1, 2]);
    expect(await countRepeatInfringerReview()).toBe(2);
  });

  it('plans the per-user grouping on the migration’s partial index', async () => {
    await user(1);
    await copyright(1, [30, 20, 10]);
    await db.exec(readFileSync(MIGRATION, 'utf8').replace(/CONCURRENTLY /g, ''));
    await db.exec('SET enable_seqscan = off');
    const queries: { sql: string; parameters: readonly unknown[] }[] = [];
    dbHandle.current = new Kysely({
      dialect: pgliteDialect(db),
      log: (event) => {
        queries.push(event.query);
      },
    });
    await countRepeatInfringerReview();

    const plan = await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN ${queries[0].sql}`,
      queries[0].parameters as unknown[]
    );
    expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
      'UserStrike_copyright_user_created_idx'
    );
  });
});

const event = (fields: Record<string, string | number>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
  return {
    request: { formData: async () => form },
    locals: { user: { id: 42, username: 'mod42' }, grants: {} },
  } as never;
};

describe('repeat-infringer Reviewed action', () => {
  beforeEach(async () => {
    await user(1);
    await copyright(1, [30, 20, 10]);
  });

  it('records the review with its note, and takes the account out of the queue', async () => {
    const result = await actions.repeatInfringerReviewed(
      event({ userId: 1, note: 'warned, no ban' })
    );

    expect(result).toEqual({ success: true });
    expect(addUserNote).toHaveBeenCalledExactlyOnceWith({
      userId: 1,
      notes: 'Repeat-infringer review: warned, no ban',
      author: 'mod42',
    });
    const { rows } = await db.query<{ review: { reviewedAt: string; reviewedBy: number } }>(
      `SELECT "meta"->'repeatInfringerReview' AS review FROM "User" WHERE id = 1`
    );
    expect(rows[0].review.reviewedBy).toBe(42);
    expect(await queued()).toEqual([]);
  });

  it('refuses without a note, and writes nothing', async () => {
    const result = await actions.repeatInfringerReviewed(event({ userId: 1, note: '  ' }));

    expect(result).toMatchObject({ status: 400 });
    expect(addUserNote).not.toHaveBeenCalled();
    expect(await queued()).toEqual([1]);
  });

  it('refuses an account that is not in the queue', async () => {
    await user(2);
    const result = await actions.repeatInfringerReviewed(event({ userId: 2, note: 'x' }));

    expect(result).toMatchObject({ status: 409 });
    expect(addUserNote).not.toHaveBeenCalled();
  });
});
