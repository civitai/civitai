import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';
import type * as PlacementService from '~/server/services/placement.service';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The /storylines "Recently updated" sort and "Participated" filter, run as written against an
 * in-process Postgres built from the shipped storyline migrations: both are decided in SQL.
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
const { getBlockedPairIds } = await import('~/server/services/user-preferences.service');

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
const WRITER = 3;
const COLLABORATOR = 4;
const INVITEE = 5;
const REMOVED_WRITER = 6;

// Storylines, each started by OWNER; ids ascend in the order they were created.
const QUIET = 1; // chapter 1 only, 5 days ago
const CONTINUED = 2; // chapter 1 9 days ago, WRITER's chapter 1 day ago
const REMOVED = 3; // chapter 1 8 days ago, REMOVED_WRITER's chapter 12 hours ago, removed
const BANNED_AUTHOR = 4; // chapter 1 7 days ago, a banned author's chapter 5 hours ago
const SCHEDULED = 5; // chapter 1 6 days ago, a chapter whose post goes out tomorrow
const TAKEN_DOWN = 6; // chapter 1 10 days ago, a chapter 2 hours ago whose post was taken down
const DELETED_AUTHOR = 7; // chapter 1 11 days ago, a deleted author's chapter 4 hours ago
const LATE_PUBLISHED = 8; // chapter 1 12 days ago, a chapter added 4 days ago, published 3 hours ago

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
    '20261215120000_storyline_collaborator_accepted',
  ])
    await db.pg.exec(migration(name));

  await db.pg.exec(`
    INSERT INTO "User" (id, username, "bannedAt") VALUES
      (1, 'owner', NULL), (2, 'stranger', NULL), (3, 'writer', NULL), (4, 'collaborator', NULL),
      (5, 'invitee', NULL), (6, 'removed-writer', NULL), (7, 'banned', now() - interval '1 hour');
    INSERT INTO "User" (id, username, "deletedAt") VALUES (8, 'deleted', now() - interval '1 hour');
    INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt") VALUES
      (1, 1, 'Quiet', 1, now()), (2, 1, 'Continued', 1, now()), (3, 1, 'Removed', 1, now()),
      (4, 1, 'Banned author', 1, now()), (5, 1, 'Scheduled', 1, now()),
      (6, 1, 'Taken down', 1, now()), (7, 1, 'Deleted author', 1, now()),
      (8, 1, 'Late published', 1, now());
    INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt") VALUES
      (100, 1, 1, now() - interval '5 days'),
      (200, 1, 1, now() - interval '9 days'), (201, 3, 1, now() - interval '1 day'),
      (300, 1, 1, now() - interval '8 days'), (301, 6, 1, now() - interval '12 hours'),
      (400, 1, 1, now() - interval '7 days'), (401, 7, 1, now() - interval '5 hours'),
      (500, 1, 1, now() - interval '6 days'), (501, 1, 1, now() + interval '1 day'),
      (600, 1, 1, now() - interval '10 days'),
      (700, 1, 1, now() - interval '11 days'), (701, 8, 1, now() - interval '4 hours'),
      (800, 1, 1, now() - interval '12 days'), (801, 1, 1, now() - interval '3 hours');
    INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt", "tosViolation") VALUES
      (601, 1, 1, now() - interval '2 hours', true);
    INSERT INTO "StorylineChapter" (id, "storylineId", "postId", "userId", depth, "createdAt", "removedAt") VALUES
      (10, 1, 100, 1, 0, now() - interval '5 days', NULL),
      (20, 2, 200, 1, 0, now() - interval '9 days', NULL),
      (21, 2, 201, 3, 1, now() - interval '1 day', NULL),
      (30, 3, 300, 1, 0, now() - interval '8 days', NULL),
      (31, 3, 301, 6, 1, now() - interval '12 hours', now() - interval '1 hour'),
      (40, 4, 400, 1, 0, now() - interval '7 days', NULL),
      (41, 4, 401, 7, 1, now() - interval '5 hours', NULL),
      (50, 5, 500, 1, 0, now() - interval '6 days', NULL),
      (51, 5, 501, 1, 1, now() - interval '2 hours', NULL),
      (60, 6, 600, 1, 0, now() - interval '10 days', NULL),
      (61, 6, 601, 1, 1, now() - interval '2 hours', NULL),
      (70, 7, 700, 1, 0, now() - interval '11 days', NULL),
      (71, 7, 701, 8, 1, now() - interval '4 hours', NULL),
      (80, 8, 800, 1, 0, now() - interval '12 days', NULL),
      (81, 8, 801, 1, 1, now() - interval '4 days', NULL);
    INSERT INTO "StorylineCollaborator" ("storylineId", "userId", "acceptedAt") VALUES
      (1, 4, now()), (1, 5, NULL);
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

const feedIds = async ({
  filter = 'all',
  sort = 'newest',
  viewerId = STRANGER,
  cursor,
  limit = 20,
}: {
  filter?: 'all' | 'participated';
  sort?: 'newest' | 'recentlyUpdated';
  viewerId?: number | null;
  cursor?: number;
  limit?: number;
}) => {
  const page = await getStorylinesInfinite({
    filter,
    sort,
    cursor,
    limit,
    viewer: viewerId == null ? undefined : { id: viewerId },
    browsingLevel: NsfwLevel.PG,
  });
  return { ids: page.items.map((item) => item.id), nextCursor: page.nextCursor };
};

describe('the Recently updated sort', () => {
  it('orders by when the last live chapter went out; removed, taken-down, banned or deleted-author and unpublished chapters do not count', async () => {
    expect((await feedIds({ sort: 'recentlyUpdated' })).ids).toEqual([
      LATE_PUBLISHED,
      CONTINUED,
      QUIET,
      SCHEDULED,
      BANNED_AUTHOR,
      REMOVED,
      TAKEN_DOWN,
      DELETED_AUTHOR,
    ]);
  });

  it('pages on without repeating or skipping a storyline', async () => {
    const first = await feedIds({ sort: 'recentlyUpdated', limit: 2 });
    expect(first.ids).toEqual([LATE_PUBLISHED, CONTINUED]);
    const second = await feedIds({ sort: 'recentlyUpdated', limit: 2, cursor: first.nextCursor });
    expect(second.ids).toEqual([QUIET, SCHEDULED]);
  });

  it('leaves Newest by creation', async () => {
    expect((await feedIds({})).ids).toEqual([
      LATE_PUBLISHED,
      DELETED_AUTHOR,
      TAKEN_DOWN,
      SCHEDULED,
      BANNED_AUTHOR,
      REMOVED,
      CONTINUED,
      QUIET,
    ]);
  });
});

describe('the Participated filter', () => {
  it('lists the storylines a reader wrote a live chapter in', async () => {
    expect((await feedIds({ filter: 'participated', viewerId: WRITER })).ids).toEqual([CONTINUED]);
  });

  it('lists a storyline where the reader is an accepted collaborator with no chapter yet', async () => {
    expect((await feedIds({ filter: 'participated', viewerId: COLLABORATOR })).ids).toEqual([
      QUIET,
    ]);
  });

  it('leaves out a storyline whose only chapter by the reader was removed', async () => {
    expect((await feedIds({ filter: 'participated', viewerId: REMOVED_WRITER })).ids).toEqual([]);
  });

  it('leaves out an invitation not yet accepted, and lists nothing for a stranger or a guest', async () => {
    expect((await feedIds({ filter: 'participated', viewerId: INVITEE })).ids).toEqual([]);
    expect((await feedIds({ filter: 'participated', viewerId: STRANGER })).ids).toEqual([]);
    expect((await feedIds({ filter: 'participated', viewerId: null })).ids).toEqual([]);
  });

  it('includes the storylines the owner started', async () => {
    expect((await feedIds({ filter: 'participated', viewerId: OWNER })).ids).toEqual([
      LATE_PUBLISHED,
      DELETED_AUTHOR,
      TAKEN_DOWN,
      SCHEDULED,
      BANNED_AUTHOR,
      REMOVED,
      CONTINUED,
      QUIET,
    ]);
  });
});

describe("a search's candidate ids", () => {
  const searchIds = async (ids: number[]) =>
    (
      await getStorylinesInfinite({
        ids,
        filter: 'all',
        sort: 'newest',
        limit: ids.length,
        viewer: { id: STRANGER },
        browsingLevel: NsfwLevel.PG,
      })
    ).items.map((item) => item.id);

  it('returns only those storylines, under the feed gates', async () => {
    expect(await searchIds([QUIET, CONTINUED])).toEqual([CONTINUED, QUIET]);
  });

  it('still leaves out a creator the viewer blocked or who blocked them', async () => {
    vi.mocked(getBlockedPairIds).mockResolvedValueOnce([OWNER]);
    expect(await searchIds([QUIET, CONTINUED])).toEqual([]);
  });
});
