import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshAppFeedbackSourceDb, seedUser } from './feedback-pglite.harness';

/**
 * `20270104120000_feedback_app_source_commit`, EXECUTED, and its CHECK probed with rows. Each
 * rejection is asserted by constraint name, and the accepted app-block row is the control that
 * proves the probe values are otherwise valid.
 */

const COMMIT = '05c2d58a1b2c3d4e5f60718293a4b5c6d7e8f901';

let db: PGlite;
let reporterId: number;

beforeEach(async () => {
  db = await freshAppFeedbackSourceDb();
  reporterId = await seedUser(db, 'reporter');
});

afterEach(async () => {
  await db.close();
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

describe('Feedback_app_source_columns_check', () => {
  it.each([
    ['appSourceCommit', COMMIT],
    ['appSourceDirty', false],
  ])('rejects %s on a non-app-block row, by this constraint', async (column, value) => {
    await expect(insertFeedback('site-bug-report', { [column]: value })).rejects.toMatchObject({
      code: '23514',
      constraint: 'Feedback_app_source_columns_check',
    });
  });

  it('ends VALIDATED, though Part 1 adds it NOT VALID', async () => {
    const res = await db.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint
        WHERE conrelid = '"Feedback"'::regclass AND conname = 'Feedback_app_source_columns_check'`
    );
    expect(res.rows).toEqual([{ convalidated: true }]);
  });

  it('accepts both on an app-block row, and keeps a NULL dirty flag NULL', async () => {
    const clean = await insertFeedback('app-block', {
      appSourceCommit: COMMIT,
      appSourceDirty: false,
    });
    const unknown = await insertFeedback('app-block', { appSourceCommit: COMMIT });
    const res = await db.query<{
      id: number;
      appSourceCommit: string;
      appSourceDirty: boolean | null;
    }>(
      'SELECT "id", "appSourceCommit", "appSourceDirty" FROM "Feedback" WHERE "id" = ANY($1) ORDER BY "id"',
      [[clean, unknown]]
    );
    expect(res.rows).toEqual([
      { id: clean, appSourceCommit: COMMIT, appSourceDirty: false },
      { id: unknown, appSourceCommit: COMMIT, appSourceDirty: null },
    ]);
  });
});
