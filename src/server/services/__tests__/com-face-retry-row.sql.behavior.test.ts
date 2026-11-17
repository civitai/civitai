import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dueRetryRowSql } from '~/server/services/model-com-face-recheck.service';

/**
 * An edit the queue could not take is written as a due retry row. A model already waiting keeps the
 * deadline of its oldest unverified edit, or repeated edits during an outage would keep its face up
 * past the window.
 */

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE "KeyValue" (key text PRIMARY KEY, value jsonb NOT NULL);`);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`TRUNCATE "KeyValue";`);
});

const write = async (modelId: number, since: Date) => {
  const sql = dueRetryRowSql(modelId, since);
  await db.query(sql.text, sql.values);
};
const row = async (modelId: number) =>
  (
    await db.query<{ value: unknown }>(`SELECT value FROM "KeyValue" WHERE key = $1`, [
      `com-face-recheck:${modelId}`,
    ])
  ).rows[0]?.value;

describe('the due retry row for an edit the queue missed', () => {
  it('starts the clock for a model not yet waiting', async () => {
    await write(7, new Date('2026-11-05T12:00:00.000Z'));

    expect(await row(7)).toEqual({ since: '2026-11-05T12:00:00.000Z', attempt: 0, nextAt: '' });
  });

  it('keeps the deadline of a model already waiting, resetting only the backoff', async () => {
    await db.query(`INSERT INTO "KeyValue" (key, value) VALUES ($1, $2::jsonb)`, [
      'com-face-recheck:7',
      JSON.stringify({
        since: '2026-11-04T08:00:00.000Z',
        attempt: 4,
        nextAt: '2026-11-05T13:00:00.000Z',
      }),
    ]);

    await write(7, new Date('2026-11-05T12:00:00.000Z'));

    expect(await row(7)).toEqual({ since: '2026-11-04T08:00:00.000Z', attempt: 0, nextAt: '' });
  });
});
