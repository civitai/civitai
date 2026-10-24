import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';
import type * as PlacementService from '~/server/services/placement.service';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * A storyline started before its first post, run as written against an in-process Postgres built
 * from the shipped storyline migrations: the pending-chapter table's constraints, and the feed
 * query leaving out a storyline with no chapter 1 for everyone but its owner and moderators. All
 * of it lives in SQL, which a mocked client cannot see.
 */

vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  getAllHiddenForUser: vi.fn().mockResolvedValue({ hiddenImages: [], hiddenTags: [] }),
  getBlockedPairIds: vi.fn().mockResolvedValue([]),
  HiddenUsers: { getCached: vi.fn().mockResolvedValue([]) },
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: vi.fn().mockResolvedValue({ emptyResult: false }),
}));
vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  placementPriceRanges: vi.fn().mockResolvedValue(new Map()),
}));

const { getStorylinesInfinite } = await import('~/server/services/storyline.service');

const migration = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );

const db = { pg: null as unknown as PGlite };
const r = dbMock.dbRead;

const OWNER = 1;
const STRANGER = 2;
const MODERATOR = 3;
/** Storyline 1 has chapter 1 (post 100); storyline 2 was started with no post yet. */
const WITH_CHAPTER = 1;
const EMPTY = 2;
const OTHER_STORY_CHAPTER = 11;

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY, username text, "bannedAt" timestamp(3),
      "deletedAt" timestamp(3));
    CREATE TABLE "Post" ("id" integer PRIMARY KEY, "userId" integer, "nsfwLevel" integer NOT NULL DEFAULT 0,
      "publishedAt" timestamp(3), "tosViolation" boolean NOT NULL DEFAULT false);
    CREATE TABLE "Report" ("id" integer PRIMARY KEY);
    CREATE TABLE "Image" ("id" integer PRIMARY KEY);
    CREATE TABLE "PlacementSpace" (surface text, "entityType" text, "entityId" integer, mode text,
      price integer);
  `);
  for (const name of [
    '20261023120000_storylines',
    '20261023130000_storyline_children_index',
    '20261023140000_storyline_engagement',
    '20261024120000_storyline_chapter_removed',
    '20261024130000_storyline_cover_hero',
    '20261024140000_storyline_title_moderation',
    '20261024150000_storyline_moderator_takedown',
    '20261024160000_storyline_minor_by_scan',
    '20261106120000_storyline_rejoin',
    '20261122120000_storyline_pending_chapter',
  ])
    await db.pg.exec(migration(name));
  // Re-runnable, as its header says.
  await db.pg.exec(migration('20261122120000_storyline_pending_chapter'));

  await db.pg.exec(`
    INSERT INTO "User" (id, username) VALUES (1, 'owner'), (2, 'stranger'), (3, 'mod');
    INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt") VALUES
      (100, 1, 1, now() - interval '1 day'), (110, 1, 1, now() - interval '1 day'),
      (200, 1, 0, NULL), (201, 2, 0, NULL), (202, 2, 0, NULL), (203, 1, 0, NULL);
    INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt") VALUES
      (1, 1, 'Started from a post', 1, now()), (2, 1, 'Started empty', 1, now()),
      (3, 1, 'Another story', 1, now());
    INSERT INTO "StorylineChapter" (id, "storylineId", "postId", "userId", depth) VALUES
      (10, 1, 100, 1, 0), (11, 3, 110, 1, 0);
  `);

  const raw = pgliteRaw(db.pg);
  // The feed's own statement runs in Postgres; its image reads find nothing.
  r.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.join('?').includes('FROM "Storyline" st')
      ? raw.queryRaw(strings, ...values)
      : Promise.resolve([])) as never);
});

afterAll(async () => {
  await db.pg.close();
});

const insertPending = (postId: number, storylineId: number, parentChapterId: number | null) =>
  db.pg.query(
    `INSERT INTO "StorylinePendingChapter" ("postId", "storylineId", "parentChapterId", "userId")
     VALUES ($1, $2, $3, 1)`,
    [postId, storylineId, parentChapterId]
  );

describe('the pending-chapter migration', () => {
  beforeEach(async () => {
    await db.pg.exec(`DELETE FROM "StorylinePendingChapter"`);
  });

  it('keeps one chapter-1 draft per storyline, and any number of continuations', async () => {
    await insertPending(200, EMPTY, null);
    await expect(insertPending(203, EMPTY, null)).rejects.toThrow(
      /StorylinePendingChapter_storylineId_root_key/
    );
    await insertPending(201, WITH_CHAPTER, 10);
    await insertPending(202, WITH_CHAPTER, 10);
    const rows = await db.pg.query(`SELECT "postId" FROM "StorylinePendingChapter" ORDER BY 1`);
    expect(rows.rows).toEqual([{ postId: 200 }, { postId: 201 }, { postId: 202 }]);
  });

  it("refuses a parent chapter from another storyline than the draft's", async () => {
    await expect(insertPending(201, WITH_CHAPTER, OTHER_STORY_CHAPTER)).rejects.toThrow(
      /StorylinePendingChapter_parentChapterId_storylineId_fkey/
    );
  });

  it('goes with its post when the draft is deleted', async () => {
    await insertPending(203, EMPTY, null);
    await db.pg.exec(`DELETE FROM "Post" WHERE id = 203`);
    const rows = await db.pg.query(`SELECT 1 FROM "StorylinePendingChapter" WHERE "postId" = 203`);
    expect(rows.rows).toEqual([]);
  });
});

describe('the storylines feed', () => {
  const feedIds = async (viewer?: { id: number; isModerator?: boolean }) =>
    (
      await getStorylinesInfinite({
        filter: 'all',
        sort: 'newest',
        limit: 20,
        viewer,
        browsingLevel: NsfwLevel.PG,
      })
    ).items.map((item) => item.id);

  it('lists a storyline with no chapter 1 only to its owner and moderators', async () => {
    await expect(feedIds(undefined)).resolves.toEqual([3, WITH_CHAPTER]);
    await expect(feedIds({ id: STRANGER })).resolves.toEqual([3, WITH_CHAPTER]);
    await expect(feedIds({ id: OWNER })).resolves.toEqual([3, EMPTY, WITH_CHAPTER]);
    await expect(feedIds({ id: MODERATOR, isModerator: true })).resolves.toEqual([
      3,
      EMPTY,
      WITH_CHAPTER,
    ]);
  });

  it('gives the owner their empty storyline with no chapter 1 and no cover', async () => {
    const { items } = await getStorylinesInfinite({
      filter: 'all',
      sort: 'newest',
      limit: 20,
      viewer: { id: OWNER },
      browsingLevel: NsfwLevel.PG,
    });
    expect(items.find((item) => item.id === EMPTY)).toMatchObject({
      rootPostId: null,
      chapterCount: 0,
      coverImage: null,
    });
  });
});
