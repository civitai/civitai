import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';
import { storylineChapterAddedQuery } from '~/server/notifications/storyline.notifications';
import type * as PlacementService from '~/server/services/placement.service';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * 'storyline-chapter-added' and the /storylines Following filter, run as written against an
 * in-process Postgres built from the shipped storyline migrations, the follow migration included.
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

const OWNER = 1;
const COLLABORATOR = 2;
const RANDOM = 3;
const CANON_FOLLOWER = 4;
const ENDORSED_FOLLOWER = 5;
const EVERYTHING_FOLLOWER = 6;
const INVITEE = 7;
const MUTED = 8;
const SAFE_ONLY = 9;
const BANNED_AUTHOR = 10;
const DELETED_AUTHOR = 11;
const BANNED_FOLLOWER = 12;
const DELETED_FOLLOWER = 13;
const BANNED_OWNER = 14;
const DELETED_OWNER = 15;
const BLOCKS_AUTHOR = 16; // blocked RANDOM
const BLOCKED_BY_AUTHOR = 17; // RANDOM blocked them
const HIDES_AUTHOR = 18; // hid RANDOM
const BLOCKS_OWNER = 19; // blocked OWNER
const BLOCKED_BY_OWNER = 20; // OWNER blocked them

// Each storyline has one fresh chapter (an hour ago), so a row names which chapter it announced.
const CANON = 1; // RANDOM's chapter, on the main path
const ENDORSED = 2; // COLLABORATOR's chapter, off the main path
const COMMUNITY = 3; // RANDOM's chapter, off the main path
const INVITED = 4; // a chapter by someone invited, not yet accepted, off the main path
const TAKEN_DOWN = 5; // as CANON, but the storyline's title is taken down by the scan
const REMOVED = 6; // as CANON, but the chapter was removed
const MATURE = 7; // as CANON, its chapter 1 rated R
// Each of these is as CANON but for one thing, and announces nothing.
const BY_BANNED = 8; // the chapter's author is banned
const BY_DELETED = 9; // the chapter's author is deleted
const UNPUBLISHED = 10; // the chapter's post is unpublished
const POST_TAKEN_DOWN = 11; // the chapter's post is taken down
const STALE = 12; // the chapter went out 8 days ago, past the 7-day cap
const OWNER_BANNED = 13;
const OWNER_DELETED = 14;
const ROOT_HIDDEN = 15; // chapter 1 is unrated, so the storyline is hidden

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY, username text, "bannedAt" timestamp(3),
      "deletedAt" timestamp(3), "browsingLevel" integer NOT NULL DEFAULT 31);
    CREATE TABLE "Post" ("id" integer PRIMARY KEY, "userId" integer, "nsfwLevel" integer NOT NULL DEFAULT 0,
      "publishedAt" timestamp(3), "tosViolation" boolean NOT NULL DEFAULT false);
    CREATE TABLE "Report" ("id" integer PRIMARY KEY);
    CREATE TABLE "Image" ("id" integer PRIMARY KEY);
    CREATE TABLE "PlacementSpace" (surface text, "entityType" text, "entityId" integer, mode text,
      price integer);
    CREATE TABLE "UserEngagement" ("userId" integer, "targetUserId" integer, type text);
    CREATE TABLE "UserNotificationSettings" ("userId" integer, type text);
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
    INSERT INTO "User" (id, username, "browsingLevel", "bannedAt", "deletedAt")
      SELECT g, 'u' || g, CASE WHEN g = 9 THEN 1 ELSE 31 END,
        CASE WHEN g IN (10, 12, 14) THEN now() - interval '1 day' END,
        CASE WHEN g IN (11, 13, 15) THEN now() - interval '1 day' END
      FROM generate_series(1, 20) g;
    INSERT INTO "UserEngagement" ("userId", "targetUserId", type) VALUES
      (16, 3, 'Block'), (3, 17, 'Block'), (18, 3, 'Hide'), (19, 1, 'Block'), (1, 20, 'Block');
    INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt", "tosViolation", "tosViolationByScan")
      SELECT g, CASE g WHEN ${OWNER_BANNED} THEN ${BANNED_OWNER} WHEN ${OWNER_DELETED} THEN ${DELETED_OWNER} ELSE 1 END, 'Story ' || g,
        CASE WHEN g = 7 THEN 4 ELSE 1 END, now(), g = 5, g = 5
      FROM generate_series(1, 15) g;
    -- Per storyline g: chapter 1 (g*10) and an old canon chapter 2 (g*10+1), a month old; then the
    -- fresh chapter (g*10+2), an hour old.
    INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt")
      SELECT g * 10, s."userId", CASE g WHEN 7 THEN 4 WHEN 15 THEN 0 ELSE 1 END, now() - interval '30 days'
        FROM generate_series(1, 15) g JOIN "Storyline" s ON s.id = g
      UNION ALL SELECT g * 10 + 1, 1, 1, now() - interval '30 days' FROM generate_series(1, 15) g;
    INSERT INTO "StorylineChapter" (id, "storylineId", "postId", "userId", depth, "createdAt")
      SELECT g * 10, g, g * 10, s."userId", 0, now() - interval '30 days'
        FROM generate_series(1, 15) g JOIN "Storyline" s ON s.id = g
      UNION ALL SELECT g * 10 + 1, g, g * 10 + 1, 1, 1, now() - interval '30 days' FROM generate_series(1, 15) g;
    INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon)
      SELECT g, g * 10 + 1, g * 10, true FROM generate_series(1, 15) g;
    INSERT INTO "StorylineCollaborator" ("storylineId", "userId", "acceptedAt") VALUES
      (2, 2, now()), (4, 7, NULL);
  `);
  const fresh: [storyline: number, author: number, canon: boolean][] = [
    [CANON, RANDOM, true],
    [ENDORSED, COLLABORATOR, false],
    [COMMUNITY, RANDOM, false],
    [INVITED, INVITEE, false],
    [TAKEN_DOWN, RANDOM, true],
    [REMOVED, RANDOM, true],
    [MATURE, RANDOM, true],
    [BY_BANNED, BANNED_AUTHOR, true],
    [BY_DELETED, DELETED_AUTHOR, true],
    [UNPUBLISHED, RANDOM, true],
    [POST_TAKEN_DOWN, RANDOM, true],
    [STALE, RANDOM, true],
    [OWNER_BANNED, RANDOM, true],
    [OWNER_DELETED, RANDOM, true],
    [ROOT_HIDDEN, RANDOM, true],
  ];
  for (const [g, author, canon] of fresh) {
    const id = g * 10 + 2;
    // A canon chapter continues the main path's end; any other forks from chapter 1.
    const parent = canon ? g * 10 + 1 : g * 10;
    const at = g === STALE ? `now() - interval '8 days'` : `now() - interval '1 hour'`;
    await db.pg.exec(`
      INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt", "tosViolation")
        VALUES (${id}, ${author}, 1, ${g === UNPUBLISHED ? 'NULL' : at}, ${g === POST_TAKEN_DOWN});
      INSERT INTO "StorylineChapter" (id, "storylineId", "postId", "userId", depth, "createdAt", "removedAt")
        VALUES (${id}, ${g}, ${id}, ${author}, 2, ${at},
          ${g === REMOVED ? `now() - interval '10 minutes'` : 'NULL'});
      INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon)
        VALUES (${g}, ${id}, ${parent}, ${canon});
    `);
  }

  // Applied once storylines and accepted collaborators exist, so its backfill has rows to follow.
  await db.pg.exec(migration('20261224120000_storyline_follow'));
  await db.pg.exec(`
    INSERT INTO "StorylineFollow" ("storylineId", "userId", scope)
      SELECT s, f.id, f.scope::"StorylineFollowScope"
      FROM generate_series(1, 15) s,
        (VALUES (4, 'Canon'), (5, 'Endorsed'), (6, 'Everything'), (3, 'Everything'),
          (8, 'Everything'), (9, 'Everything'), (12, 'Everything'), (13, 'Everything'),
          (16, 'Everything'), (17, 'Everything'), (18, 'Everything'), (19, 'Everything'),
          (20, 'Everything')) f(id, scope);
    INSERT INTO "UserNotificationSettings" ("userId", type) VALUES (8, 'storyline-chapter-added');
  `);

  const raw = pgliteRaw(db.pg);
  dbMock.dbRead.$queryRaw.mockImplementation(((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) =>
    strings.join('?').includes('FROM "Storyline" st')
      ? raw.queryRaw(strings, ...values)
      : Promise.resolve([])) as never);
});

afterAll(async () => {
  await db.pg.close();
});

type Row = { key: string; userId: number; type: string; details: { storylineId: number } };

const DAY_AGO = new Date(Date.now() - 24 * 3600_000).toISOString();
const run = async (lastSent = DAY_AGO) =>
  (await db.pg.query<Row>(storylineChapterAddedQuery({ lastSent }))).rows;

/** Who was told about which storyline, as `storylineId:userId`. */
const told = (rows: Row[], users?: number[]) =>
  rows
    .filter((row) => !users || users.includes(row.userId))
    .map((row) => `${row.details.storylineId}:${row.userId}`)
    .sort();

describe('the scope matrix', () => {
  let rows: Row[];
  beforeAll(async () => {
    rows = await run();
  });

  it('tells a Canon follower only about a chapter on the main path', () => {
    expect(told(rows, [CANON_FOLLOWER])).toEqual([
      `${CANON}:${CANON_FOLLOWER}`,
      `${MATURE}:${CANON_FOLLOWER}`,
    ]);
  });

  it("tells an Endorsed follower about the main path and an accepted collaborator's chapter", () => {
    expect(told(rows, [ENDORSED_FOLLOWER])).toEqual([
      `${CANON}:${ENDORSED_FOLLOWER}`,
      `${ENDORSED}:${ENDORSED_FOLLOWER}`,
      `${MATURE}:${ENDORSED_FOLLOWER}`,
    ]);
  });

  it('tells an Everything follower about every live chapter, an invitee’s included', () => {
    expect(told(rows, [EVERYTHING_FOLLOWER])).toEqual([
      `${CANON}:${EVERYTHING_FOLLOWER}`,
      `${ENDORSED}:${EVERYTHING_FOLLOWER}`,
      `${COMMUNITY}:${EVERYTHING_FOLLOWER}`,
      `${INVITED}:${EVERYTHING_FOLLOWER}`,
      `${MATURE}:${EVERYTHING_FOLLOWER}`,
    ]);
  });

  it.each([
    ['its title is taken down', TAKEN_DOWN],
    ['the chapter was removed', REMOVED],
    ["the chapter's author is banned", BY_BANNED],
    ["the chapter's author is deleted", BY_DELETED],
    ["the chapter's post is unpublished", UNPUBLISHED],
    ["the chapter's post is taken down", POST_TAKEN_DOWN],
    ['the owner is banned', OWNER_BANNED],
    ['the owner is deleted', OWNER_DELETED],
    ['chapter 1 is hidden', ROOT_HIDDEN],
  ])('tells nobody about a storyline when %s', (_, storylineId) => {
    expect(rows.filter((row) => row.details.storylineId === storylineId)).toEqual([]);
  });

  it('tells nobody about a chapter past the 7-day cap, however old the cursor', async () => {
    const fromLongAgo = await run(new Date(Date.now() - 20 * 24 * 3600_000).toISOString());
    expect(told(fromLongAgo, [EVERYTHING_FOLLOWER])).toContain(`${CANON}:${EVERYTHING_FOLLOWER}`);
    expect(fromLongAgo.filter((row) => row.details.storylineId === STALE)).toEqual([]);
  });

  it('tells a banned or deleted follower nothing', () => {
    expect(told(rows, [BANNED_FOLLOWER, DELETED_FOLLOWER])).toEqual([]);
  });

  // Either direction of a block, or the follower hiding the author, silences that author's chapter
  // only; a block between the follower and the owner silences the whole storyline.
  it('never tells someone about a chapter by a user they blocked, hid, or who blocked them', () => {
    for (const follower of [BLOCKS_AUTHOR, BLOCKED_BY_AUTHOR, HIDES_AUTHOR]) {
      expect(told(rows, [follower])).not.toContain(`${CANON}:${follower}`);
      expect(told(rows, [follower])).toContain(`${ENDORSED}:${follower}`);
    }
  });

  it('never tells someone about a storyline whose owner they blocked, or who blocked them', () => {
    expect(told(rows, [BLOCKS_OWNER, BLOCKED_BY_OWNER])).toEqual([]);
  });

  it('respects a mute, and never tells an author about their own chapter', () => {
    expect(told(rows, [MUTED])).toEqual([]);
    expect(told(rows, [RANDOM])).toEqual([`${ENDORSED}:${RANDOM}`, `${INVITED}:${RANDOM}`]);
  });

  it("keeps a story above a follower's browsing level out of their notifications", () => {
    expect(told(rows, [SAFE_ONLY])).not.toContain(`${MATURE}:${SAFE_ONLY}`);
    expect(told(rows, [SAFE_ONLY])).toContain(`${CANON}:${SAFE_ONLY}`);
  });

  it('has the migration follow owners and accepted collaborators, at Canon', () => {
    expect(told(rows, [OWNER])).toEqual(
      [CANON, MATURE].map((s) => `${s}:${OWNER}`) // the owner's own chapters are not news
    );
    expect(told(rows, [COLLABORATOR, INVITEE])).toEqual([]);
  });
});

describe('a burst of chapters', () => {
  beforeEach(() =>
    db.pg.exec(`
      DELETE FROM "StorylineChapterEdge" WHERE "chapterId" >= 1000;
      DELETE FROM "StorylineChapter" WHERE id >= 1000;
      DELETE FROM "Post" WHERE id >= 1000;
    `)
  );

  const addChapter = (id: number, parent: number) =>
    db.pg.exec(`
      INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt") VALUES (${id}, ${RANDOM}, 1, now());
      INSERT INTO "StorylineChapter" (id, "storylineId", "postId", "userId", depth, "createdAt")
        VALUES (${id}, ${COMMUNITY}, ${id}, ${RANDOM}, 2, now());
      INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon)
        VALUES (${COMMUNITY}, ${id}, ${parent}, false);
    `);

  it('sends one per follower, however many chapters land in a run or across runs that hour', async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    const follower = (rows: Row[]) =>
      rows.filter(
        (row) => row.userId === EVERYTHING_FOLLOWER && row.details.storylineId === COMMUNITY
      );
    // One transaction, so both runs read the same now(): the hour cannot turn between them.
    await db.pg.exec('BEGIN');
    try {
      await addChapter(1000, COMMUNITY * 10);
      await addChapter(1001, COMMUNITY * 10);
      const first = follower(await run(since));
      await addChapter(1002, COMMUNITY * 10);
      const second = follower(await run(since));
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(second[0].key).toBe(first[0].key);
    } finally {
      await db.pg.exec('ROLLBACK');
    }
  });
});

describe('the Following filter', () => {
  const following = async (viewerId: number) =>
    (
      await getStorylinesInfinite({
        filter: 'following',
        sort: 'newest',
        limit: 20,
        viewer: { id: viewerId },
        browsingLevel: NsfwLevel.PG,
      })
    ).items.map((item) => item.id);

  it('lists the storylines a reader follows, and drops one they unfollow', async () => {
    expect(await following(COLLABORATOR)).toEqual([ENDORSED]);
    await db.pg.exec(`DELETE FROM "StorylineFollow" WHERE "userId" = ${COLLABORATOR}`);
    expect(await following(COLLABORATOR)).toEqual([]);
    expect(await following(INVITEE)).toEqual([]);
  });

  it('stays unfollowed when the follow migration is run again', async () => {
    await db.pg.exec(`DELETE FROM "StorylineFollow" WHERE "userId" = ${COLLABORATOR}`);
    await db.pg.exec(migration('20261224120000_storyline_follow'));
    expect(await following(COLLABORATOR)).toEqual([]);
  });
});
