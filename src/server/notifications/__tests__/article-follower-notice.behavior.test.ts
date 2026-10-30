import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  newArticleFromFollowingMessage,
  newArticleFromFollowingQuery,
} from '~/server/notifications/article.notifications';

/**
 * Runs the real `new-article-from-following` query against an in-process Postgres.
 *
 * The clock is pinned (`public.now()` shadows `pg_catalog.now()` via `search_path`) and every
 * timestamp crosses the boundary as a string, because PGlite shifts a JS `Date` sent against a
 * `timestamp WITHOUT time zone` by the local offset.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

type Row = {
  key: string;
  userId: number;
  type: string;
  details: {
    articleId: number;
    articleTitle: string;
    username: string;
    articleCategory: string | null;
  };
};

const AUTHOR = 101;
const OTHER_AUTHOR = 102;
const F1 = 201;
const F2 = 202;
const LATE_FOLLOWER = 203;
const OPTED_OUT = 204;
const BLOCKED_BY_AUTHOR = 205;

const NOW = '2026-10-16 10:00:30+00';
/** The previous run's cursor. */
const LAST_SENT = '2026-10-16T10:00:00.000Z';

let db: PGlite;

const run = async (lastSent = LAST_SENT) =>
  (await db.query<Row>(newArticleFromFollowingQuery({ lastSent }))).rows.sort(
    (a, b) => a.key.localeCompare(b.key) || a.userId - b.userId
  );

const recipientsOf = (rows: Row[], articleId: number) =>
  rows.filter((r) => r.details.articleId === articleId).map((r) => r.userId);

async function article(
  id: number,
  publishedAt: string | null,
  {
    status = 'Published',
    category = 'announcement' as string | null,
    userId = AUTHOR,
    tosViolation = false,
  } = {}
) {
  await db.query(
    `INSERT INTO "Article" (id, "userId", title, status, "publishedAt", "tosViolation")
     VALUES ($1, $2, $3, $4, $5::timestamp, $6)`,
    [id, userId, `Article ${id}`, status, publishedAt, tosViolation]
  );
  if (category) {
    const tag = await db.query<{ id: number }>(`SELECT id FROM "Tag" WHERE name = $1`, [category]);
    await db.query(`INSERT INTO "TagsOnArticle" ("articleId", "tagId") VALUES ($1, $2)`, [
      id,
      tag.rows[0].id,
    ]);
  }
  // A plain, non-category tag on every article: the category lookup must not pick it up.
  await db.query(`INSERT INTO "TagsOnArticle" ("articleId", "tagId") VALUES ($1, 9)`, [id]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    SET TIME ZONE 'UTC';
    CREATE TABLE test_clock (t timestamptz NOT NULL);
    INSERT INTO test_clock VALUES ('${NOW}');
    CREATE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS 'SELECT t FROM test_clock';
    CREATE TABLE "User" (
      id INT PRIMARY KEY,
      username TEXT,
      "bannedAt" TIMESTAMP(3),
      muted BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE "Article" (
      id INT PRIMARY KEY,
      "userId" INT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      "publishedAt" TIMESTAMP(3),
      "tosViolation" BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE "Tag" (id INT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE "TagsOnTags" ("fromTagId" INT NOT NULL, "toTagId" INT NOT NULL);
    CREATE TABLE "TagsOnArticle" ("articleId" INT NOT NULL, "tagId" INT NOT NULL);
    CREATE TABLE "UserEngagement" (
      "userId" INT NOT NULL,
      "targetUserId" INT NOT NULL,
      type TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT '2026-01-01',
      PRIMARY KEY ("userId", "targetUserId")
    );
    CREATE TABLE "UserNotificationSettings" ("userId" INT NOT NULL, type TEXT NOT NULL);
    SET search_path = public, pg_catalog;
  `);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "User", "Article", "Tag", "TagsOnTags", "TagsOnArticle", "UserEngagement",
      "UserNotificationSettings";
    UPDATE test_clock SET t = '${NOW}';
    INSERT INTO "User" (id, username) VALUES
      (${AUTHOR}, 'author'), (${OTHER_AUTHOR}, 'other'), (${F1}, 'f1'), (${F2}, 'f2'),
      (${LATE_FOLLOWER}, 'late'), (${OPTED_OUT}, 'quiet'), (${BLOCKED_BY_AUTHOR}, 'blocker');
    INSERT INTO "Tag" VALUES
      (1, 'article category'), (2, 'announcement'), (3, 'guide'), (8, 'genre'), (9, 'music');
    -- 'music' has a parent too, just not 'article category'.
    INSERT INTO "TagsOnTags" VALUES (1, 2), (1, 3), (8, 9);
    INSERT INTO "UserEngagement" ("userId", "targetUserId", type) VALUES
      (${F1}, ${AUTHOR}, 'Follow'),
      (${F2}, ${AUTHOR}, 'Follow'),
      (${OPTED_OUT}, ${AUTHOR}, 'Follow'),
      (${BLOCKED_BY_AUTHOR}, ${AUTHOR}, 'Follow'),
      -- One row per pair, as in prod: a follower cannot also block or hide the author, so the
      -- reachable block is the author's.
      (${AUTHOR}, ${BLOCKED_BY_AUTHOR}, 'Block');
    INSERT INTO "UserEngagement" ("userId", "targetUserId", type, "createdAt") VALUES
      (${LATE_FOLLOWER}, ${AUTHOR}, 'Follow', '2026-10-16 10:00:20');
    INSERT INTO "UserNotificationSettings" VALUES (${OPTED_OUT}, 'new-article-from-following');
    -- Another type's opt-out must not silence this one.
    INSERT INTO "UserNotificationSettings" VALUES (${F1}, 'new-article-from-following-x');
  `);
});

describe('new-article-from-following — who gets what, executed', () => {
  it('positive control: an article published after the cursor reaches its followers, with its category', async () => {
    await article(11, '2026-10-16 10:00:10');

    const rows = await run();
    expect(recipientsOf(rows, 11)).toEqual([F1, F2]);
    expect(rows[0]).toEqual({
      key: 'new-article-from-following:11',
      userId: F1,
      type: 'new-article-from-following',
      details: {
        articleId: 11,
        articleTitle: 'Article 11',
        username: 'author',
        articleCategory: 'announcement',
      },
    });
  });

  it('a follower who followed after the article was published, an opted-out follower and one the author blocked are left out', async () => {
    await article(11, '2026-10-16 10:00:10');
    // Exactly these, so neither an empty result nor an extra recipient passes.
    expect(recipientsOf(await run(), 11)).toEqual([F1, F2]);
  });

  it('only Published articles: unpublished, draft and processing rows that carry a publishedAt are skipped', async () => {
    await article(11, '2026-10-16 10:00:10', { status: 'Unpublished' });
    await article(12, '2026-10-16 10:00:10', { status: 'UnpublishedViolation' });
    await article(13, '2026-10-16 10:00:10', { status: 'Draft' });
    await article(14, '2026-10-16 10:00:10', { status: 'Processing' });
    await article(15, '2026-10-16 10:00:10');

    expect([...new Set((await run()).map((r) => r.details.articleId))]).toEqual([15]);
  });

  describe('articles a follower should not be sent', () => {
    // F1 also follows OTHER_AUTHOR, whose article is the positive control in each case.
    beforeEach(async () => {
      await db.exec(
        `INSERT INTO "UserEngagement" ("userId", "targetUserId", type) VALUES (${F1}, ${OTHER_AUTHOR}, 'Follow')`
      );
      await article(12, '2026-10-16 10:00:10', { userId: OTHER_AUTHOR });
    });
    const announced = async () => [...new Set((await run()).map((r) => r.details.articleId))];

    it('an article taken down for a ToS violation', async () => {
      await article(11, '2026-10-16 10:00:10', { tosViolation: true });
      expect(await announced()).toEqual([12]);
    });

    it('an article by a banned author', async () => {
      await db.exec(`UPDATE "User" SET "bannedAt" = '2026-10-16 09:00' WHERE id = ${AUTHOR}`);
      await article(11, '2026-10-16 10:00:10');
      expect(await announced()).toEqual([12]);
    });

    it('an article by a muted author', async () => {
      await db.exec(`UPDATE "User" SET muted = true WHERE id = ${AUTHOR}`);
      await article(11, '2026-10-16 10:00:10');
      expect(await announced()).toEqual([12]);
    });
  });

  it('a future-dated publishedAt is not announced until it arrives', async () => {
    await article(11, '2030-08-25 00:00:00');
    expect(await run()).toEqual([]);

    await db.exec(`UPDATE test_clock SET t = '2030-08-25 00:00:30+00'`);
    // LATE_FOLLOWER followed in 2026, before this publish date, so they are included here.
    expect(recipientsOf(await run('2030-08-25T00:00:00.000Z'), 11)).toEqual([
      F1,
      F2,
      LATE_FOLLOWER,
    ]);
  });
});

describe('🔴 the cursor race — a row the previous run could not see yet', () => {
  it('an article stamped just BEFORE the cursor is still announced by the next run', async () => {
    // Stamped 10:00:00.000 - 400ms by the app, committed and replicated after the previous run took
    // its cursor (10:00:00) and queried. Without a lookback, `publishedAt > lastSent` drops it forever.
    await article(11, '2026-10-16 09:59:59.600');
    expect(recipientsOf(await run(), 11)).toEqual([F1, F2]);
  });

  it('the lookback is bounded: an article older than five minutes before the cursor is not re-read', async () => {
    await article(11, '2026-10-16 09:54:59');
    await article(12, '2026-10-16 09:55:01');
    expect([...new Set((await run()).map((r) => r.details.articleId))]).toEqual([12]);
  });

  it('overlapping runs emit identical rows under the same per-article key', async () => {
    await article(11, '2026-10-16 10:00:10');
    const first = await run('2026-10-16T10:00:00.000Z');
    await db.exec(`UPDATE test_clock SET t = '2026-10-16 10:01:30+00'`);
    const second = await run('2026-10-16T10:01:00.000Z');

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });
});

describe('articles with no category — notified anyway (Justin, 2026-10-16)', () => {
  it('an article published before its author picked a category reaches followers, with a null category', async () => {
    // It still carries the non-category 'music' tag, which must not be reported as its category.
    await article(11, '2026-10-16 10:00:10', { category: null });

    const rows = await run();
    expect(recipientsOf(rows, 11)).toEqual([F1, F2]);
    expect(rows[0].details.articleCategory).toBeNull();
  });

  it('an article with two categories is announced once per follower', async () => {
    await article(11, '2026-10-16 10:00:10', { category: 'guide' });
    await db.query(`INSERT INTO "TagsOnArticle" ("articleId", "tagId") VALUES (11, 2)`);

    const rows = await run();
    expect(recipientsOf(rows, 11)).toEqual([F1, F2]);
    expect(rows[0].details.articleCategory).toBe('announcement');
  });
});

describe('newArticleFromFollowingMessage', () => {
  it('names the category when there is one', () => {
    expect(
      newArticleFromFollowingMessage({
        username: 'author',
        articleCategory: 'announcement',
        articleTitle: 'Hello',
      })
    ).toBe('author published a new announcement article: "Hello"');
  });

  it('reads naturally without one, never "a new null article"', () => {
    expect(
      newArticleFromFollowingMessage({
        username: 'author',
        articleCategory: null,
        articleTitle: 'Hello',
      })
    ).toBe('author published a new article: "Hello"');
  });
});
