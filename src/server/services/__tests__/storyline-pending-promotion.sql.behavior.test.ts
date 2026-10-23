import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Which of the storyline owner's drafts the readiness pass picks up, run as written against an
 * in-process Postgres built from the shipped storyline migrations. The selection is the pass's only
 * filter on "live and rated", so a draft it lets through early becomes a chapter early.
 */

const { selectReadyPendingChapters } = await import('~/server/services/storyline-publish.service');

const migration = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );

const db = { pg: null as unknown as PGlite };

const OWNER = 1;
const STRANGER = 2;
const PG = 1;
const PG13 = 2;
const R = 4;
const X = 8;

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY, username text, "bannedAt" timestamp(3),
      "deletedAt" timestamp(3), muted boolean NOT NULL DEFAULT false);
    CREATE TABLE "Post" ("id" integer PRIMARY KEY, "userId" integer, "nsfwLevel" integer NOT NULL DEFAULT 0,
      "publishedAt" timestamp(3), "tosViolation" boolean NOT NULL DEFAULT false);
    CREATE TABLE "Report" ("id" integer PRIMARY KEY);
    CREATE TABLE "Image" ("id" serial PRIMARY KEY, "postId" integer, ingestion text NOT NULL DEFAULT 'Scanned',
      "needsReview" text, "tosViolation" boolean NOT NULL DEFAULT false,
      minor boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false);
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
  await db.pg.exec(`INSERT INTO "User" (id, username) VALUES (1, 'owner'), (2, 'stranger');`);

  const raw = pgliteRaw(db.pg);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.pg.exec(`
    UPDATE "User" SET muted = false;
    DELETE FROM "StorylinePendingChapter";
    DELETE FROM "StorylineChapterEdge";
    DELETE FROM "StorylineChapter";
    DELETE FROM "Storyline";
    DELETE FROM "Image";
    DELETE FROM "Post";
  `);
});

let nextId = 1;
const storyline = async ({ maxNsfwLevel = PG, minorByScan = false, tosViolation = false } = {}) => {
  const id = nextId++;
  await db.pg.query(
    `INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "minorByScan", "tosViolation", "updatedAt")
     VALUES ($1, $2, 'A story', $3, $4, $5, now())`,
    [id, OWNER, maxNsfwLevel, minorByScan, tosViolation]
  );
  return id;
};

type PostOptions = {
  userId?: number;
  nsfwLevel?: number;
  publishedAt?: string | null;
  tosViolation?: boolean;
  images?: Record<string, unknown>[];
};
const post = async ({
  userId = OWNER,
  nsfwLevel = PG,
  publishedAt = "now() - interval '1 minute'",
  tosViolation = false,
  images = [{}],
}: PostOptions = {}) => {
  const id = nextId++;
  await db.pg.query(
    `INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt", "tosViolation")
     VALUES ($1, $2, $3, ${publishedAt ?? 'NULL'}, $4)`,
    [id, userId, nsfwLevel, tosViolation]
  );
  for (const image of images)
    await db.pg.query(
      `INSERT INTO "Image" ("postId", ingestion, "needsReview", "tosViolation", minor, poi)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        image.ingestion ?? 'Scanned',
        image.needsReview ?? null,
        image.tosViolation ?? false,
        image.minor ?? false,
        image.poi ?? false,
      ]
    );
  return id;
};

const chapter = async (storylineId: number, postId: number | null, depth = 0, removed = false) => {
  const id = nextId++;
  await db.pg.query(
    `INSERT INTO "StorylineChapter" (id, "storylineId", "postId", "userId", depth, "removedAt")
     VALUES ($1, $2, $3, $4, $5, ${removed ? 'now()' : 'NULL'})`,
    [id, storylineId, postId, OWNER, depth]
  );
  return id;
};

const pending = (
  postId: number,
  storylineId: number,
  parentChapterId: number | null = null,
  userId = OWNER
) =>
  db.pg.query(
    `INSERT INTO "StorylinePendingChapter" ("postId", "storylineId", "parentChapterId", "userId")
     VALUES ($1, $2, $3, $4)`,
    [postId, storylineId, parentChapterId, userId]
  );

const selected = async () => (await selectReadyPendingChapters(100)).map((row) => row.postId);

/** A storyline with chapter 1, and a draft continuing it. */
const continuation = async (draft: PostOptions = {}, story = {}, removed = false) => {
  const storylineId = await storyline(story);
  const root = await chapter(storylineId, await post(), 0, removed);
  const postId = await post(draft);
  await pending(postId, storylineId, root, draft.userId);
  return postId;
};

describe("the readiness pass's selection", () => {
  it("picks up the owner's live, rated chapter 1 and continuation", async () => {
    const first = await post();
    await pending(first, await storyline());
    const next = await continuation();

    expect(await selected()).toEqual([first, next]);
  });

  it.each<[string, PostOptions]>([
    ['never published', { publishedAt: null }],
    ['scheduled for later', { publishedAt: "now() + interval '1 hour'" }],
    ['not rated', { nsfwLevel: 0 }],
    ['still scanning', { images: [{}, { ingestion: 'Pending' }] }],
    ['in review', { images: [{ needsReview: 'minor' }] }],
    ['without images', { images: [] }],
    ['refused by the scan', { images: [{ tosViolation: true }] }],
    ['flagged as a minor', { images: [{ minor: true }] }],
    ['flagged as a real person', { images: [{ poi: true }] }],
    ['taken down', { tosViolation: true }],
  ])('leaves a chapter-1 draft %s', async (_name, options) => {
    await pending(await post(options), await storyline());

    expect(await selected()).toEqual([]);
  });

  it("leaves a contributor's draft, which is submitted rather than written", async () => {
    await continuation({ userId: STRANGER });
    const storylineId = await storyline();
    await pending(await post({ userId: STRANGER }), storylineId, null, STRANGER);

    expect(await selected()).toEqual([]);
  });

  it('leaves a draft in a taken-down storyline, or under a removed parent', async () => {
    await pending(await post(), await storyline({ tosViolation: true }));
    await continuation({}, {}, true);

    expect(await selected()).toEqual([]);
  });

  it("leaves a draft under a parent whose post is gone, and a muted owner's draft", async () => {
    const storylineId = await storyline();
    const root = await chapter(storylineId, null);
    await pending(await post(), storylineId, root);
    const ready = await post();
    await pending(ready, await storyline());
    expect(await selected()).toEqual([ready]);

    await db.pg.exec(`UPDATE "User" SET muted = true WHERE id = ${OWNER}`);
    expect(await selected()).toEqual([]);
  });

  it('takes at most a batch, lowest post first', async () => {
    const posts = [];
    for (let i = 0; i < 3; i++) {
      const postId = await post();
      await pending(postId, await storyline());
      posts.push(postId);
    }

    expect((await selectReadyPendingChapters(2)).map((row) => row.postId)).toEqual(
      posts.slice(0, 2)
    );
  });

  it('leaves a draft whose post is already a chapter, or a storyline that has its chapter 1', async () => {
    const storylineId = await storyline();
    const postId = await post();
    await chapter(storylineId, postId);
    const other = await storyline();
    await chapter(other, await post());
    await pending(postId, await storyline());
    await pending(await post(), other);

    expect(await selected()).toEqual([]);
  });

  describe('by rating', () => {
    it('picks up a chapter 1 above the ceiling, which it will raise', async () => {
      const postId = await post({ nsfwLevel: X | PG });
      await pending(postId, await storyline({ maxNsfwLevel: PG }));

      expect(await selected()).toEqual([postId]);
    });

    it('leaves a chapter 1 above safe for work in a minor-flagged storyline, and takes one within it', async () => {
      await pending(await post({ nsfwLevel: R }), await storyline({ minorByScan: true }));
      const within = await post({ nsfwLevel: PG13 });
      await pending(within, await storyline({ minorByScan: true }));

      expect(await selected()).toEqual([within]);
    });

    it('leaves a continuation above the ceiling, which nothing raises, and takes one at it', async () => {
      await continuation({ nsfwLevel: R }, { maxNsfwLevel: PG13 });
      const at = await continuation({ nsfwLevel: PG13 | PG }, { maxNsfwLevel: PG13 });
      await continuation({ nsfwLevel: R }, { maxNsfwLevel: X, minorByScan: true });

      expect(await selected()).toEqual([at]);
    });

    it('leaves a chapter 1 rated Blocked', async () => {
      await pending(await post({ nsfwLevel: 32 }), await storyline());

      expect(await selected()).toEqual([]);
    });
  });
});
