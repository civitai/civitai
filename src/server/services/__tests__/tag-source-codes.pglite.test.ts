import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The real tag-row functions and TagsOnImageDetails view, as the migrations define them.
const migration = (name: string) =>
  readFileSync(
    join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations', name, 'migration.sql'),
    'utf8'
  );

const IMAGE = 1;
const TAG = 10;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "TagSource" AS ENUM ('User', 'Rekognition', 'WD14', 'Computed', 'ImageHash', 'Hive',
      'MinorDetection', 'HiveDemographics', 'SpineRating', 'AiRecognition', 'AnimeRecognition');
    CREATE TABLE "Image" (id INTEGER PRIMARY KEY);
    CREATE TABLE "Tag" (id INTEGER PRIMARY KEY, "nsfwLevel" INTEGER NOT NULL DEFAULT 1);
    INSERT INTO "Image" VALUES (${IMAGE});
    INSERT INTO "Tag" VALUES (${TAG});
  `);
  await db.exec(migration('20250303170613_tags_on_image_new'));
  await db.exec(migration('20250414192734_tag_type'));
  await db.exec(migration('20271208120000_tag_source_codes_8_12'));
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`DELETE FROM "TagsOnImageNew"`);
});

type Details = { source: string; automated: boolean; disabled: boolean; confidence: number };

const details = async () =>
  (
    await db.query<Details>(
      `SELECT source, automated, disabled, confidence FROM "TagsOnImageDetails"
       WHERE "imageId" = $1 AND "tagId" = $2`,
      [IMAGE, TAG]
    )
  ).rows[0];

const upsert = (source: string | null, confidence: number | null, automated: boolean | null) =>
  db.query(`SELECT upsert_tag_on_image($1, $2, $3::"TagSource", $4, $5)`, [
    IMAGE,
    TAG,
    source,
    confidence,
    automated,
  ]);

describe('tag source codes', () => {
  it.each(['Hive', 'HiveDemographics', 'SpineRating', 'AiRecognition', 'AnimeRecognition'])(
    'a %s tag reads back as its own source, not User',
    async (source) => {
      await upsert(source, 90, true);
      expect(await details()).toEqual({ source, automated: true, disabled: false, confidence: 90 });
    }
  );

  it('keeps the flags of a negative-attributes row when an update sets only the confidence', async () => {
    await upsert('SpineRating', 90, true);
    await upsert(null, 40, null);
    expect(await details()).toEqual({
      source: 'SpineRating',
      automated: true,
      disabled: false,
      confidence: 40,
    });
  });

  it('a row moved from a code of 8 or more to User is no longer negative', async () => {
    await upsert('Hive', 90, true);
    await upsert('User', 5, false);
    expect(await details()).toEqual({
      source: 'User',
      automated: false,
      disabled: false,
      confidence: 5,
    });
  });

  it('a NULL source still packs as 0, which reads back as User', async () => {
    await upsert(null, 3, true);
    const { rows } = await db.query<{ attributes: number }>(
      `SELECT attributes FROM "TagsOnImageNew" WHERE "imageId" = $1`,
      [IMAGE]
    );
    expect(rows[0].attributes >> 12).toBe(0);
    expect((await details()).source).toBe('User');
  });
});
