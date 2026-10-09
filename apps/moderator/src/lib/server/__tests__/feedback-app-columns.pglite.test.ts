import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appListingMigrationParts, freshAppFeedbackDb, seedUser } from './feedback-pglite.harness';

/**
 * `20261011120000_feedback_app_listing`, EXECUTED — Part 1 then Part 2, as a human applies it — and
 * its two CHECKs probed with rows.
 *
 * 🔴 WHY ROWS. The migration is applied by hand and nothing else in CI runs it. A text test can say
 * a column name appears near the constraint; only an INSERT says the constraint rejects it. Dropping
 * a column from `Feedback_app_columns_check` used to leave every test green.
 *
 * Every rejection is asserted by CONSTRAINT NAME, not just by "it threw": a non-app-block row
 * carrying `appListingId` could also fail on the foreign key, and a test that accepts any error
 * would stay green with the CHECK gone. So each probe uses a value that satisfies every OTHER
 * constraint — a real listing, a real user, an `ownerStatus` inside its vocabulary — and the
 * accepted-row case below is the control that proves those values are otherwise valid.
 */

const LISTING_ID = 'al_feedback_test';
const AT = '2026-09-01T12:00:00.000Z';

let db: PGlite;
let reporterId: number;
/** A DIFFERENT user from the reporter: deleting the reporter cascades the row away. */
let ownerId: number;

beforeEach(async () => {
  db = await freshAppFeedbackDb();
  reporterId = await seedUser(db, 'reporter');
  ownerId = await seedUser(db, 'owner');
  await db.query('INSERT INTO "app_listings" ("id") VALUES ($1)', [LISTING_ID]);
});

afterEach(async () => {
  await db.close();
});

/** The eight app-only columns, each with a value valid for every constraint but the area CHECK. */
const appColumns = (): Record<string, string | number> => ({
  appListingId: LISTING_ID,
  appBlockVersion: '1.4.0',
  appBlockSha: 'abc1234',
  ownerStatus: 'resolved',
  ownerStatusAt: AT,
  ownerStatusById: ownerId,
  ownerFlaggedAt: AT,
  hiddenFromOwnerAt: AT,
});

async function insertFeedback(area: string, columns: Record<string, unknown>): Promise<number> {
  const names = Object.keys(columns);
  const res = await db.query<{ id: number }>(
    `INSERT INTO "Feedback" ("area", "userId", "message", "context"${names
      .map((n) => `, "${n}"`)
      .join('')})
     VALUES ($1, $2, 'msg', '{}'::jsonb${names.map((_, i) => `, $${i + 3}`).join('')})
     RETURNING "id"`,
    [area, reporterId, ...Object.values(columns)]
  );
  return res.rows[0].id;
}

describe('Feedback_app_columns_check', () => {
  it.each(Object.keys(appColumns()))(
    'rejects %s on a non-app-block row, by this constraint',
    async (column) => {
      await expect(
        insertFeedback('site-bug-report', { [column]: appColumns()[column] })
      ).rejects.toMatchObject({ code: '23514', constraint: 'Feedback_app_columns_check' });
    }
  );

  it('accepts all eight on an app-block row (the control: every probe value is otherwise valid)', async () => {
    const id = await insertFeedback('app-block', appColumns());
    const res = await db.query<{ n: number }>(
      `SELECT ((("appListingId" IS NOT NULL)::int + ("appBlockVersion" IS NOT NULL)::int
               + ("appBlockSha" IS NOT NULL)::int + ("ownerStatus" IS NOT NULL)::int
               + ("ownerStatusAt" IS NOT NULL)::int + ("ownerStatusById" IS NOT NULL)::int
               + ("ownerFlaggedAt" IS NOT NULL)::int + ("hiddenFromOwnerAt" IS NOT NULL)::int)) AS n
         FROM "Feedback" WHERE "id" = $1`,
      [id]
    );
    expect(res.rows[0].n).toBe(8);
  });

  it('requires nothing of an app-block row, and nothing of a non-app-block row with the columns NULL', async () => {
    await expect(insertFeedback('app-block', {})).resolves.toEqual(expect.any(Number));
    await expect(insertFeedback('site-bug-report', {})).resolves.toEqual(expect.any(Number));
  });

  it('lets ON DELETE SET NULL clear appListingId and ownerStatusById on an app-block row', async () => {
    const id = await insertFeedback('app-block', appColumns());
    await db.query('DELETE FROM "app_listings" WHERE "id" = $1', [LISTING_ID]);
    await db.query('DELETE FROM "User" WHERE "id" = $1', [ownerId]);
    const res = await db.query<{ appListingId: string | null; ownerStatusById: number | null }>(
      'SELECT "appListingId", "ownerStatusById" FROM "Feedback" WHERE "id" = $1',
      [id]
    );
    expect(res.rows[0]).toEqual({ appListingId: null, ownerStatusById: null });
  });
});

describe('Feedback_ownerStatus_check', () => {
  it('rejects a status outside the vocabulary, by this constraint', async () => {
    await expect(
      insertFeedback('app-block', { appListingId: LISTING_ID, ownerStatus: 'done' })
    ).rejects.toMatchObject({ code: '23514', constraint: 'Feedback_ownerStatus_check' });
  });

  it.each(['acknowledged', 'resolved', 'wont_fix'])('accepts %s', async (status) => {
    await expect(
      insertFeedback('app-block', { appListingId: LISTING_ID, ownerStatus: status })
    ).resolves.toEqual(expect.any(Number));
  });
});

describe('the migration as applied', () => {
  it('creates the eight columns, four constraints and a VALID owner-inbox index', async () => {
    const columns = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'Feedback'
          AND column_name IN ('appListingId', 'appBlockVersion', 'appBlockSha', 'ownerStatus',
                              'ownerStatusAt', 'ownerStatusById', 'ownerFlaggedAt', 'hiddenFromOwnerAt')`
    );
    const constraints = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conrelid = '"Feedback"'::regclass
          AND conname IN ('Feedback_appListingId_fkey', 'Feedback_ownerStatusById_fkey',
                          'Feedback_ownerStatus_check', 'Feedback_app_columns_check')`
    );
    const index = await db.query<{ indisvalid: boolean }>(
      `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'Feedback_appListingId_createdAt_idx'`
    );
    expect([columns.rows[0].n, constraints.rows[0].n, index.rows]).toEqual([
      8,
      4,
      [{ indisvalid: true }],
    ]);
  });

  it('is idempotent: both parts re-run cleanly', async () => {
    const { part1, part2 } = appListingMigrationParts();
    await expect(db.exec(part1)).resolves.toBeDefined();
    await expect(db.exec(part2)).resolves.toBeDefined();
  });

  /**
   * Part 1's lock_timeout must not outlive Part 1: Part 2 is a concurrent index build, and a
   * lock_timeout firing there leaves an INVALID index. `SET LOCAL` ends at Part 1's COMMIT; a bare
   * `SET` would still be in force here. (The timeout's EFFECT — failing fast behind a held "User"
   * row lock — needs two sessions, which PGlite does not have; that was measured on a scratch
   * Postgres, see the PR.)
   */
  it("leaves no lock_timeout behind for Part 2's session", async () => {
    const res = await db.query<{ lock_timeout: string }>('SHOW lock_timeout');
    expect(res.rows[0].lock_timeout).toBe('0');
  });
});
