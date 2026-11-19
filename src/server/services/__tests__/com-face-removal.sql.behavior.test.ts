import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { comFaceRemovalSql } from '~/server/services/model-com-face-recheck.service';

/**
 * Taking a model off .com clears its .com cover and records the marker in `meta`, but only while the
 * cover is still the one the check read: a cover picked since then went through the save gate.
 */

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    `CREATE TABLE "Model" (id int PRIMARY KEY, "sfwCoverImageId" int, meta jsonb DEFAULT '{}'::jsonb);`
  );
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`TRUNCATE "Model";`);
  await db.query(`INSERT INTO "Model" (id, "sfwCoverImageId", meta) VALUES (7, 40, $1::jsonb)`, [
    // An older marker, as a face removed, restored and removed again would carry.
    JSON.stringify({ other: 'kept', comFaceRemoved: { at: 'old', sfwCoverImageId: 1 } }),
  ]);
});

const marker = {
  at: '2026-11-05T12:00:00.000Z',
  sfwCoverImageId: 40,
  reason: 'detected' as const,
};
const remove = async (coverId: number) => {
  const sql = comFaceRemovalSql(7, coverId, marker);
  return (await db.query(sql.text, sql.values)).affectedRows;
};
const row = async () =>
  (
    await db.query<{ sfwCoverImageId: number | null; meta: Record<string, unknown> }>(
      `SELECT "sfwCoverImageId", meta FROM "Model" WHERE id = 7`
    )
  ).rows[0];

describe('the .com face removal UPDATE', () => {
  it('clears the cover and stores the new marker, keeping other meta keys', async () => {
    expect(await remove(40)).toBe(1);

    expect(await row()).toEqual({
      sfwCoverImageId: null,
      meta: { other: 'kept', comFaceRemoved: marker },
    });
  });

  it('touches nothing when the cover changed since the read', async () => {
    expect(await remove(39)).toBe(0);

    expect((await row()).sfwCoverImageId).toBe(40);
  });
});
