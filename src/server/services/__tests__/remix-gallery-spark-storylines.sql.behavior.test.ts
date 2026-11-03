import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The storylines a host image's card lists, run as written against an in-process Postgres built
 * from the shipped storyline migrations and the spark migration.
 */

const { getBlockedPairIds } = vi.hoisted(() => ({ getBlockedPairIds: vi.fn() }));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  getBlockedPairIds,
  HiddenUsers: { getCached: async () => [] },
}));

const { getRemixGalleryCardSummaries } = await import('~/server/services/remix-gallery.service');

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

const HOST_OWNER = 1;
const STARTER = 2;
const VIEWER = 9;
/** Open gallery, rated PG. */
const HOST = 500;
const PG = 1;
const R = 4;

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TABLE "User" (id integer PRIMARY KEY, username text, "bannedAt" timestamp(3),
      "deletedAt" timestamp(3));
    CREATE TABLE "Post" (id integer PRIMARY KEY, "userId" integer, "nsfwLevel" integer NOT NULL DEFAULT 1,
      "publishedAt" timestamp(3) DEFAULT now() - interval '1 day',
      "tosViolation" boolean NOT NULL DEFAULT false,
      availability "Availability" NOT NULL DEFAULT 'Public');
    CREATE TABLE "Report" (id integer PRIMARY KEY);
    CREATE TABLE "Image" (id integer PRIMARY KEY, "postId" integer, "userId" integer,
      url text NOT NULL DEFAULT 'u', type text NOT NULL DEFAULT 'image',
      "nsfwLevel" integer NOT NULL DEFAULT 1, index integer,
      "tosViolation" boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false,
      "acceptableMinor" boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false,
      "modelRestricted" boolean, ingestion text NOT NULL DEFAULT 'Scanned', "needsReview" text);
    CREATE TABLE "PlacementSpace" (surface text, "entityType" text, "entityId" integer,
      mode text, price integer, settings jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE "UserEngagement" ("userId" integer, "targetUserId" integer, type text);
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
    '20261220120000_storyline_spark_image',
  ])
    await db.pg.exec(migration(name));
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  getBlockedPairIds.mockResolvedValue([]);
  const raw = pgliteRaw(db.pg);
  r.$queryRaw.mockImplementation((async (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.join('?').includes('WITH listed AS') ? raw.queryRaw(strings, ...values) : []) as never);
  await db.pg.exec(`
    TRUNCATE "User", "Post", "Image", "PlacementSpace", "UserEngagement", "Storyline",
      "StorylineChapter" CASCADE;
    INSERT INTO "User" (id, username) VALUES
      (1, 'host'), (2, 'starter'), (3, 'other'), (6, 'closed'), (9, 'viewer');
    -- Host images: 500 open; 501 off on the image; 502 off on its post; 503 owned by an account
    -- that is off, re-opened on the image.
    INSERT INTO "Post" (id, "userId") VALUES (950, 1), (951, 1), (952, 6);
    INSERT INTO "Image" (id, "postId", "userId") VALUES (500, 950, 1), (501, 950, 1),
      (502, 951, 1), (503, 952, 6);
    INSERT INTO "PlacementSpace" (surface, "entityType", "entityId", mode) VALUES
      ('remixGallery', 'image', 501, 'off'), ('remixGallery', 'post', 951, 'off'),
      ('remixGallery', 'user', 6, 'off'), ('remixGallery', 'image', 503, 'review');
  `);
});

/** A storyline sparked by `host`, with chapter 1 (post `id * 10`, one PG image) unless `root` is false. */
async function story(
  id: number,
  host: number,
  {
    userId = STARTER,
    root = true,
    rootLevel = PG,
    tosViolation = false,
  }: { userId?: number; root?: boolean; rootLevel?: number; tosViolation?: boolean } = {}
) {
  await db.pg.exec(`
    INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "sparkImageId", "tosViolation",
      "updatedAt")
    VALUES (${id}, ${userId}, 'Story ${id}', 16, ${host}, ${tosViolation}, now());
  `);
  if (root) await chapter(id, 0, { level: rootLevel, userId });
}

async function chapter(
  storylineId: number,
  depth: number,
  { level = PG, userId = STARTER, removed = false } = {}
) {
  const id = storylineId * 10 + depth;
  await db.pg.exec(`
    INSERT INTO "Post" (id, "userId", "nsfwLevel") VALUES (${id}, ${userId}, ${level});
    INSERT INTO "Image" (id, "postId", "userId", url, "nsfwLevel")
      VALUES (${id}, ${id}, ${userId}, 'img-${id}', ${level});
    INSERT INTO "StorylineChapter" (id, "storylineId", "postId", "userId", depth, "removedAt")
      VALUES (${id}, ${storylineId}, ${id}, ${userId}, ${depth}, ${removed ? 'now()' : 'NULL'});
  `);
}

const listed = async (hosts = [HOST], viewer: { id: number } | undefined = { id: VIEWER }) => {
  const summaries = await getRemixGalleryCardSummaries({
    imageIds: hosts,
    browsingLevel: PG,
    storylinesFor: { viewer },
  });
  return Object.fromEntries(
    Object.entries(summaries).map(([host, summary]) => [
      host,
      summary.storylines?.entries.map((entry) => entry.storylineId),
    ])
  );
};

describe('storylines on a host card', () => {
  it('lists a storyline started from the host, with its count and title', async () => {
    await story(1, HOST);
    const summaries = await getRemixGalleryCardSummaries({
      imageIds: [HOST],
      browsingLevel: PG,
      storylinesFor: { viewer: { id: VIEWER } },
    });
    expect(summaries[HOST]).toEqual({
      count: 0,
      entries: [],
      storylines: {
        count: 1,
        entries: [
          {
            storylineId: 1,
            title: 'Story 1',
            username: 'starter',
            previews: [{ url: 'img-10', type: 'image', nsfwLevel: PG }],
          },
        ],
      },
    });
  });

  it('asks nothing about storylines unless told to', async () => {
    await story(1, HOST);
    await expect(
      getRemixGalleryCardSummaries({ imageIds: [HOST], browsingLevel: PG })
    ).resolves.toEqual({});
  });

  it('leaves out a storyline with no chapter 1, chapter 1 removed, or one taken down', async () => {
    await story(1, HOST, { root: false });
    await story(2, HOST, { tosViolation: true });
    await story(3, HOST);
    await story(4, HOST);
    await db.pg.exec(`UPDATE "StorylineChapter" SET "removedAt" = now() WHERE id = 40`);
    expect(await listed()).toEqual({ [HOST]: [3] });
  });

  it("leaves out a storyline above the viewer's level", async () => {
    await story(1, HOST, { rootLevel: R });
    await story(2, HOST);
    expect(await listed()).toEqual({ [HOST]: [2] });
  });

  it('resolves the gallery opt-out image, then post, then account', async () => {
    await story(1, 501);
    await story(2, 502);
    await story(3, 503);
    await story(4, HOST);
    expect(await listed([HOST, 501, 502, 503])).toEqual({ [HOST]: [4], 503: [3] });
  });

  it.each([
    ['the host owner blocked the starter', HOST_OWNER, STARTER],
    ['the starter blocked the host owner', STARTER, HOST_OWNER],
  ])('leaves out a storyline when %s', async (_name, blocker, blocked) => {
    await story(1, HOST);
    await story(2, HOST, { userId: 3 });
    await db.pg.exec(`INSERT INTO "UserEngagement" VALUES (${blocker}, ${blocked}, 'Block')`);
    expect(await listed()).toEqual({ [HOST]: [2] });
  });

  it('leaves out a storyline by someone in a block with the viewer', async () => {
    getBlockedPairIds.mockResolvedValue([STARTER]);
    await story(1, HOST);
    await story(2, HOST, { userId: 3 });
    expect(await listed()).toEqual({ [HOST]: [2] });
  });

  it('pages chapter images the viewer may see, chapter 1 first', async () => {
    await story(1, HOST);
    await chapter(1, 1, { level: R });
    await chapter(1, 2);
    await chapter(1, 3, { removed: true });
    const summaries = await getRemixGalleryCardSummaries({
      imageIds: [HOST],
      browsingLevel: PG,
      storylinesFor: { viewer: { id: VIEWER } },
    });
    expect(summaries[HOST].storylines?.entries[0].previews.map((p) => p.url)).toEqual([
      'img-10',
      'img-12',
    ]);
  });

  it('counts every listed storyline but returns the newest few', async () => {
    for (const id of [1, 2, 3, 4, 5]) await story(id, HOST);
    const summaries = await getRemixGalleryCardSummaries({
      imageIds: [HOST],
      browsingLevel: PG,
      storylinesFor: { viewer: undefined },
    });
    expect(summaries[HOST].storylines?.count).toBe(5);
    expect(summaries[HOST].storylines?.entries.map((e) => e.storylineId)).toEqual([5, 4, 3, 2]);
  });
});
