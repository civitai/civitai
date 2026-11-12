import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The tag recompute (`update_nsfw_levels_new`, from its migration) against real rows: it never takes
 * an unlocked image below a collection judge's `metadata.judgeRating` level. Ids are invented.
 */

const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20270105120000_update_nsfw_levels_new_judge_rating_floor/migration.sql'
);

const PG13 = 2;
const R = 4;
const X = 8;

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Tag" (id int PRIMARY KEY, "nsfwLevel" int NOT NULL);
    CREATE TABLE "TagsOnImageDetails" (
      "imageId" int NOT NULL, "tagId" int NOT NULL, disabled boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "nsfwLevel" int NOT NULL,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      ingestion text NOT NULL DEFAULT 'Scanned',
      "blockedFor" text,
      "needsReview" text,
      "scanJobs" jsonb,
      metadata jsonb
    );
    INSERT INTO "Tag" VALUES (1, ${PG13}), (2, ${X});
  `);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});
afterAll(() => db.close());

beforeEach(() => db.exec(`DELETE FROM "TagsOnImageDetails"; DELETE FROM "Image";`));

async function recompute(image: {
  tagLevelTagId: number;
  nsfwLevel: number;
  metadata?: object;
  locked?: boolean;
  needsReview?: string;
  scanJobs?: object;
}) {
  await db.query(
    `INSERT INTO "Image" (id, "nsfwLevel", "nsfwLevelLocked", metadata, "needsReview", "scanJobs")
     VALUES (1, $1, $2, $3, $4, $5)`,
    [
      image.nsfwLevel,
      image.locked ?? false,
      image.metadata ?? null,
      image.needsReview ?? null,
      image.scanJobs ?? null,
    ]
  );
  await db.query(`INSERT INTO "TagsOnImageDetails" ("imageId", "tagId") VALUES (1, $1)`, [
    image.tagLevelTagId,
  ]);
  await db.exec(`SELECT update_nsfw_levels_new(ARRAY[1])`);
  return (await db.query<{ nsfwLevel: number }>(`SELECT "nsfwLevel" FROM "Image" WHERE id = 1`))
    .rows[0].nsfwLevel;
}

const judgeRated = (nsfwLevel: unknown) => ({
  judgeRating: { userId: 9, nsfwLevel, collectionId: 3 },
});

describe('update_nsfw_levels_new and a judge rating', () => {
  it('keeps the judge level when the tags rate lower', async () => {
    expect(await recompute({ tagLevelTagId: 1, nsfwLevel: R, metadata: judgeRated(R) })).toBe(R);
  });

  it('takes the tag level when it is higher than the judge level', async () => {
    expect(await recompute({ tagLevelTagId: 2, nsfwLevel: R, metadata: judgeRated(R) })).toBe(X);
  });

  it('raises a lower stored level to the judge level', async () => {
    expect(await recompute({ tagLevelTagId: 1, nsfwLevel: PG13, metadata: judgeRated(X) })).toBe(X);
  });

  it.each(['csam', 'appeal'])(
    'keeps a %s review on a minor-flagged image it raises',
    async (review) => {
      await recompute({
        tagLevelTagId: 1,
        nsfwLevel: PG13,
        metadata: judgeRated(R),
        needsReview: review,
        scanJobs: { hasMinor: true },
      });
      const { rows } = await db.query<{ needsReview: string; nsfwLevel: number }>(
        `SELECT "needsReview", "nsfwLevel" FROM "Image" WHERE id = 1`
      );
      expect(rows[0]).toEqual({ needsReview: review, nsfwLevel: R });
    }
  );

  it('keeps a csam review on a minor-flagged image with no judge rating', async () => {
    await recompute({
      tagLevelTagId: 2,
      nsfwLevel: PG13,
      needsReview: 'csam',
      scanJobs: { hasMinor: true },
    });
    const { rows } = await db.query<{ needsReview: string }>(
      `SELECT "needsReview" FROM "Image" WHERE id = 1`
    );
    expect(rows[0].needsReview).toBe('csam');
  });

  it('leaves a locked level alone', async () => {
    expect(
      await recompute({ tagLevelTagId: 2, nsfwLevel: PG13, metadata: judgeRated(R), locked: true })
    ).toBe(PG13);
  });

  it.each([[{}], [judgeRated('8')], [judgeRated(32)], [judgeRated(3)]])(
    'takes the tag level as before with no valid judge rating (%j)',
    async (metadata) => {
      expect(await recompute({ tagLevelTagId: 1, nsfwLevel: X, metadata })).toBe(PG13);
    }
  );
});
