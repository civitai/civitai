import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, h } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  h: { tagRules: '[]', reindexFails: false },
}));

vi.mock('../db', () => ({
  get dbRead() {
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
// Process boundaries: Redis (tag rules cache), Meilisearch, the CDN and the reindex queue.
vi.mock('../redis', () => ({ getRedis: () => ({ get: async () => h.tagRules }) }));
vi.mock('../search-index', () => ({ syncSearchIndexBulk: vi.fn() }));
vi.mock('../cache', () => ({ bustImageTagCaches: vi.fn(async () => undefined) }));
vi.mock('../thumbnail-cache', () => ({ invalidateThumbnails: vi.fn(async () => undefined) }));
vi.mock('../profile-picture-cache', () => ({ bustProfilePictures: vi.fn(async () => undefined) }));
vi.mock('../image-models-reindex', () => ({
  queueDocumentsForImageMinorChanges: vi.fn(async () => {
    if (h.reindexFails) throw new Error('reindex queue down');
  }),
}));
vi.mock('../axiom', () => ({ logAxiomError: vi.fn(async () => undefined) }));

const { moderateImageTags } = await import('../image-tags.service');

const migration = (name: string) =>
  readFileSync(
    fileURLToPath(
      new URL(
        `../../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`,
        import.meta.url
      )
    ),
    'utf8'
  );

const PLAYER = 7001;
const MODERATOR = 9001;
const R = 4;
const X = 16;
const BLOCKED = 32;

let pg: PGlite;

beforeAll(async () => {
  pg = await freshPglite();
  await pg.exec(`
    CREATE TYPE "TagSource" AS ENUM ('User', 'Rekognition', 'WD14', 'Computed', 'ImageHash', 'MinorDetection');
    CREATE TABLE "Image" (
      id INTEGER PRIMARY KEY, type TEXT NOT NULL DEFAULT 'image', "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
      "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT false, ingestion TEXT NOT NULL DEFAULT 'Scanned',
      "blockedFor" TEXT, "needsReview" TEXT, "acceptableMinor" BOOLEAN NOT NULL DEFAULT false,
      poi BOOLEAN NOT NULL DEFAULT false, minor BOOLEAN NOT NULL DEFAULT false, "userId" INTEGER NOT NULL DEFAULT 5,
      "postId" INTEGER, metadata JSONB NOT NULL DEFAULT '{}', "scanJobs" JSONB, "pHash" BIGINT,
      "tosViolation" BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE "Post" (id INTEGER PRIMARY KEY, "publishedAt" TIMESTAMP(3), "modelVersionId" INTEGER);
    CREATE TABLE "User" (id INTEGER PRIMARY KEY, "deletedAt" TIMESTAMP, "bannedAt" TIMESTAMP, muted BOOLEAN NOT NULL DEFAULT false);
    CREATE TABLE "Model" (id INTEGER PRIMARY KEY, status TEXT NOT NULL, availability TEXT NOT NULL, "deletedAt" TIMESTAMP);
    CREATE TABLE "ModelVersion" (id INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL, status TEXT NOT NULL, availability TEXT NOT NULL);
    CREATE TABLE "Tag" (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'Moderation', "nsfwLevel" INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE "CsamReport" (id SERIAL PRIMARY KEY, "userId" INTEGER, images JSONB NOT NULL DEFAULT '[]', details JSONB);
    CREATE TABLE "Report" (id SERIAL PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE "ImageReport" ("imageId" INTEGER NOT NULL, "reportId" INTEGER NOT NULL);
    CREATE TABLE "ImageTagForReview" ("imageId" INTEGER NOT NULL, "tagId" INTEGER NOT NULL, PRIMARY KEY ("imageId", "tagId"));
    CREATE TABLE "ModActivity" (
      id SERIAL PRIMARY KEY, "userId" INTEGER, "entityType" TEXT, "entityId" INTEGER, activity TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
    );
  `);
  // The real tag-row functions and view, and the real rating recompute.
  await pg.exec(migration('20250303170613_tags_on_image_new'));
  await pg.exec(migration('20270105120000_update_nsfw_levels_new_judge_rating_floor'));
  dbHandle.current = new Kysely<DB>({ dialect: pgliteDialect(pg) });
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  h.tagRules = '[]';
  h.reindexFails = false;
  await pg.exec(`
    TRUNCATE "TagsOnImageNew", "Image", "Post", "Tag", "CsamReport", "Report",
      "ImageReport", "ModActivity", "ImageTagForReview";
    INSERT INTO "Post" VALUES (1, now() - interval '1 day');
    INSERT INTO "Tag" VALUES (10, 'flagged', 'Moderation', ${X}), (11, 'other', 'Moderation', ${R}),
      (12, 'same level', 'Moderation', ${X}), (13, 'blocked', 'Moderation', ${BLOCKED});
    INSERT INTO "Image" (id, "postId", "nsfwLevel") VALUES (100, 1, ${X});
  `);
  // Flagged: needsReview set (bit 9). Enabled: no bits.
  await flag(100, 10);
  await pg.query(`SELECT upsert_tag_on_image(100, 11)`);
});

const flag = (imageId: number, tagId: number) =>
  pg.query(`SELECT upsert_tag_on_image($1, $2, NULL, NULL, NULL, NULL, true)`, [imageId, tagId]);

async function tagRow(imageId: number, tagId: number) {
  const { rows } = await pg.query<{ disabled: boolean; needsReview: boolean }>(
    `SELECT disabled, "needsReview" FROM "TagsOnImageDetails" WHERE "imageId" = $1 AND "tagId" = $2`,
    [imageId, tagId]
  );
  return rows[0] ?? null;
}

async function activities() {
  const { rows } = await pg.query<{ userId: number; activity: string; entityId: number }>(
    `SELECT "userId", activity, "entityId" FROM "ModActivity" ORDER BY id`
  );
  return rows;
}

const level = async (imageId = 100) =>
  (
    await pg.query<{ nsfwLevel: number }>(`SELECT "nsfwLevel" FROM "Image" WHERE id = $1`, [
      imageId,
    ])
  ).rows[0]?.nsfwLevel;

const guarded = (disable: boolean, extra: { settledAtMinimum?: boolean; tagId?: number } = {}) =>
  moderateImageTags({
    imageId: 100,
    tagIds: [extra.tagId ?? 10],
    disable,
    userId: PLAYER,
    activity: 'moderateTagKono',
    onlyIfFlagged: true,
    settledAtMinimum: extra.settledAtMinimum ?? false,
  });

describe('moderateImageTags guarded (Knights write-back)', () => {
  it('keep leaves the tag enabled and no longer flagged, and records moderateTagKono for the player', async () => {
    expect(await guarded(false)).toMatchObject({ outcome: 'applied', tagIds: [10] });
    expect(await tagRow(100, 10)).toEqual({ disabled: false, needsReview: false });
    expect(await activities()).toEqual([
      { userId: PLAYER, activity: 'moderateTagKono', entityId: 100 },
    ]);
  });

  it('remove disables the tag and the rating is recomputed', async () => {
    expect(await guarded(true)).toMatchObject({ outcome: 'applied' });
    expect(await tagRow(100, 10)).toEqual({ disabled: true, needsReview: false });
    expect(await level()).toBe(R);
    expect(await activities()).toEqual([
      { userId: PLAYER, activity: 'moderateTagKono', entityId: 100 },
    ]);
  });

  it('is already-ruled when the tag is no longer flagged, or gone, and changes nothing', async () => {
    expect(await guarded(true, { tagId: 11 })).toMatchObject({ outcome: 'already-ruled' });
    expect(await guarded(true, { tagId: 12 })).toMatchObject({ outcome: 'already-ruled' });
    expect(await tagRow(100, 11)).toEqual({ disabled: false, needsReview: false });
    expect(await tagRow(100, 12)).toBeNull();
    expect(await activities()).toEqual([]);
  });

  it('a moderator ruling committed first wins', async () => {
    await moderateImageTags({ imageId: 100, tagIds: [10], disable: false, userId: MODERATOR });
    expect(await guarded(true)).toMatchObject({ outcome: 'already-ruled' });
    expect(await tagRow(100, 10)).toEqual({ disabled: false, needsReview: false });
    expect((await activities()).map((a) => a.activity)).toEqual(['moderateTag']);
  });

  it('is missing when the image is gone', async () => {
    await pg.exec(`DELETE FROM "Image" WHERE id = 100`);
    expect(await guarded(true)).toMatchObject({ outcome: 'missing' });
    expect(await activities()).toEqual([]);
  });

  it.each([
    ['flagged for minor review', `UPDATE "Image" SET "needsReview" = 'minor' WHERE id = 100`],
    ['flagged as a real person', `UPDATE "Image" SET poi = true WHERE id = 100`],
    ['flagged as a minor', `UPDATE "Image" SET minor = true WHERE id = 100`],
    ['flagged for CSAM', `UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 100`],
    ['listed on a CSAM report', `INSERT INTO "CsamReport" (images) VALUES ('[100]')`],
    ['owned by a user named on a CSAM report', `INSERT INTO "CsamReport" ("userId") VALUES (5)`],
    [
      'under an open report',
      `INSERT INTO "Report" (id, status) VALUES (1, 'Pending'); INSERT INTO "ImageReport" VALUES (100, 1)`,
    ],
  ])('is ineligible and changes nothing when the image is %s', async (_, flagIt) => {
    await pg.exec(flagIt);
    expect(await guarded(true)).toMatchObject({ outcome: 'ineligible' });
    expect(await tagRow(100, 10)).toEqual({ disabled: false, needsReview: true });
    expect(await level()).toBe(X);
    expect(await activities()).toEqual([]);
  });

  it('a report that is already actioned does not hold the image back', async () => {
    await pg.exec(
      `INSERT INTO "Report" (id, status) VALUES (1, 'Actioned'); INSERT INTO "ImageReport" VALUES (100, 1)`
    );
    expect(await guarded(false)).toMatchObject({ outcome: 'applied' });
  });

  it('is ineligible for a Blocked-level tag and changes nothing', async () => {
    await flag(100, 13);
    expect(await guarded(true, { tagId: 13 })).toMatchObject({ outcome: 'ineligible' });
    expect(await tagRow(100, 13)).toEqual({ disabled: false, needsReview: true });
    expect(await activities()).toEqual([]);
  });

  it('refuses a minimum-vote removal that would now lower the rating; the same call without it applies', async () => {
    expect(await guarded(true, { settledAtMinimum: true })).toMatchObject({
      outcome: 'ineligible',
    });
    expect(await tagRow(100, 10)).toEqual({ disabled: false, needsReview: true });
    expect(await level()).toBe(X);
    expect(await activities()).toEqual([]);

    expect(await guarded(true)).toMatchObject({ outcome: 'applied' });
    expect(await tagRow(100, 10)).toEqual({ disabled: true, needsReview: false });
  });

  it('applies a minimum-vote removal that leaves the rating where it is', async () => {
    await pg.query(`SELECT upsert_tag_on_image(100, 12)`);
    expect(await guarded(true, { settledAtMinimum: true })).toMatchObject({ outcome: 'applied' });
    expect(await level()).toBe(X);
  });
});

describe('moderateImageTags guarded, with tag rules', () => {
  it.each([
    ['an Append rule would also write another tag', 'Append'],
    ['a Replace rule would write another tag instead', 'Replace'],
  ])('is ineligible and changes nothing when %s', async (_, type) => {
    h.tagRules = JSON.stringify([{ fromId: 11, toId: 10, type }]);
    expect(await guarded(true)).toMatchObject({ outcome: 'ineligible' });
    expect(await tagRow(100, 10)).toEqual({ disabled: false, needsReview: true });
    expect(await tagRow(100, 11)).toEqual({ disabled: false, needsReview: false });
    expect(await activities()).toEqual([]);
  });
});

describe('moderateImageTags guarded, when a side effect fails after the write', () => {
  it('still records the moderateTagKono history row for the applied ruling', async () => {
    h.reindexFails = true;
    await expect(guarded(true)).rejects.toThrow('reindex queue down');
    expect(await tagRow(100, 10)).toEqual({ disabled: true, needsReview: false });
    expect(await activities()).toEqual([
      { userId: PLAYER, activity: 'moderateTagKono', entityId: 100 },
    ]);
  });
});

describe('moderateImageTags unguarded (the moderator queue)', () => {
  it('rules every flagged Moderation tag when none is named, as before, recorded as moderateTag', async () => {
    await flag(100, 13);
    expect(await moderateImageTags({ imageId: 100, disable: true, userId: MODERATOR })).toEqual({
      tagIds: expect.arrayContaining([10, 13]),
    });
    expect(await tagRow(100, 10)).toEqual({ disabled: true, needsReview: false });
    expect(await tagRow(100, 13)).toEqual({ disabled: true, needsReview: false });
    expect(await activities()).toEqual([
      { userId: MODERATOR, activity: 'moderateTag', entityId: 100 },
    ]);
  });
});
