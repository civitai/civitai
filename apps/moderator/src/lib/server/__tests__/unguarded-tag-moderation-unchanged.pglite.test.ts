import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
// Process boundaries: Redis (tag rules cache), Meilisearch, the CDN and the reindex queue.
const rules = vi.hoisted(() => ({ json: '[]' }));
vi.mock('../redis', () => ({ getRedis: () => ({ get: async () => rules.json }) }));
vi.mock('../search-index', () => ({ syncSearchIndexBulk: vi.fn() }));
vi.mock('../cache', () => ({ bustImageTagCaches: vi.fn(async () => undefined) }));
vi.mock('../thumbnail-cache', () => ({ invalidateThumbnails: vi.fn(async () => undefined) }));
vi.mock('../profile-picture-cache', () => ({ bustProfilePictures: vi.fn(async () => undefined) }));
vi.mock('../image-models-reindex', () => ({
  queueDocumentsForImageMinorChanges: vi.fn(async () => undefined),
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
      "postId" INTEGER, metadata JSONB NOT NULL DEFAULT '{}', "scanJobs" JSONB, "pHash" BIGINT
    );
    CREATE TABLE "Post" (id INTEGER PRIMARY KEY, "publishedAt" TIMESTAMP(3));
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

async function snapshot() {
  const tags = await pg.query(
    `SELECT "imageId","tagId",attributes FROM "TagsOnImageNew" ORDER BY 1,2`
  );
  const img = await pg.query(`SELECT id,"nsfwLevel","needsReview" FROM "Image" ORDER BY id`);
  const rev = await pg.query(`SELECT * FROM "ImageTagForReview" ORDER BY 1,2`);
  const act = await pg.query(
    `SELECT "userId",activity,"entityType","entityId" FROM "ModActivity" ORDER BY id`
  );
  return { tags: tags.rows, img: img.rows, rev: rev.rows, act: act.rows };
}

describe('unguarded moderator Keep/Remove (differential)', () => {
  it('keep named tag', async () => {
    const r = await moderateImageTags({
      imageId: 100,
      tagIds: [10],
      disable: false,
      userId: MODERATOR,
    });
    expect({ r, s: await snapshot() }).toMatchSnapshot();
  });
  it('remove all flagged (empty tagIds), incl. blocked tag', async () => {
    await flag(100, 13);
    const r = await moderateImageTags({ imageId: 100, disable: true, userId: MODERATOR });
    expect({ r, s: await snapshot() }).toMatchSnapshot();
  });
  it('keep all flagged incl. blocked tag (queues blocked review)', async () => {
    await flag(100, 13);
    const r = await moderateImageTags({
      imageId: 100,
      tagIds: [],
      disable: false,
      userId: MODERATOR,
    });
    expect({ r, s: await snapshot() }).toMatchSnapshot();
  });
  it('nothing flagged returns empty, writes nothing', async () => {
    const r = await moderateImageTags({
      imageId: 100,
      tagIds: [],
      disable: false,
      userId: MODERATOR,
    });
    await moderateImageTags({ imageId: 100, tagIds: [], disable: false, userId: MODERATOR });
    const r2 = await moderateImageTags({ imageId: 100, disable: true, userId: MODERATOR });
    expect({ r, r2, s: await snapshot() }).toMatchSnapshot();
  });
  it('with Replace and Append tag rules', async () => {
    rules.json = JSON.stringify([
      { fromId: 12, toId: 10, type: 'Append' },
      { fromId: 11, toId: 12, type: 'Replace' },
    ]);
    const r = await moderateImageTags({
      imageId: 100,
      tagIds: [10],
      disable: true,
      userId: MODERATOR,
    });
    rules.json = '[]';
    expect({ r, s: await snapshot() }).toMatchSnapshot();
  });
  it('unflagged named tag still written (as before)', async () => {
    const r = await moderateImageTags({
      imageId: 100,
      tagIds: [11],
      disable: true,
      userId: MODERATOR,
    });
    expect({ r, s: await snapshot() }).toMatchSnapshot();
  });
});
