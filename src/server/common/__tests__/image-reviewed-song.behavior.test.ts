import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageReviewedSql, isImageReviewed } from '~/server/common/image-visibility';

/**
 * A moderator's locked rating stands in for a scan that never arrived, for an image. A song's scan is
 * the only check of what it says, so a rating on a song that was never scanned must not publish it.
 */

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      type "MediaType" NOT NULL,
      ingestion "ImageIngestionStatus" NOT NULL,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      metadata jsonb,
      "scanJobs" jsonb
    );
    INSERT INTO "Image" (id, type, ingestion, "nsfwLevelLocked") VALUES
      (1, 'audio', 'Pending', true),
      (2, 'audio', 'Error', true),
      (3, 'audio', 'Scanned', false),
      (4, 'image', 'Pending', true),
      (5, 'image', 'Error', true),
      (6, 'video', 'Pending', true),
      (7, 'audio', 'Pending', false),
      (8, 'audio', 'Rescan', true);
  `);
});
afterAll(() => db.close());

const reviewed = async () => {
  const sql = Prisma.sql`SELECT i.id FROM "Image" i WHERE ${imageReviewedSql()} ORDER BY i.id`;
  return (await db.query<{ id: number }>(sql.text, sql.values as unknown[])).rows.map((r) => r.id);
};

describe('imageReviewedSql for a song', () => {
  it('does not count a locked rating on a song that was never scanned as a review', async () => {
    const ids = await reviewed();

    expect(ids).not.toContain(1);
    expect(ids).not.toContain(2);
    expect(ids).not.toContain(8);
    expect(ids).not.toContain(7);
  });

  it('counts a scanned song', async () => {
    expect(await reviewed()).toContain(3);
  });

  it('keeps the rule for an image or video exactly: a locked rating stands in for a stalled scan', async () => {
    const ids = await reviewed();

    expect(ids).toContain(4);
    expect(ids).toContain(5);
    expect(ids).toContain(6);
  });
});

describe('isImageReviewed, the twin of that rule', () => {
  const base = { nsfwLevelLocked: true, nsfwLevelReason: null, scanFailureClass: null };

  it.each([
    ['a locked song that is Pending', { type: 'audio', ingestion: 'Pending' }, false],
    ['a locked song in Error', { type: 'audio', ingestion: 'Error' }, false],
    ['a scanned song', { type: 'audio', ingestion: 'Scanned', nsfwLevelLocked: false }, true],
    ['a locked image that is Pending', { type: 'image', ingestion: 'Pending' }, true],
    ['a locked row of unknown type that is Pending', { ingestion: 'Pending' }, true],
  ] as const)('%s → %s', (_label, input, expected) => {
    expect(isImageReviewed({ ...base, ...input } as never)).toBe(expected);
  });
});
