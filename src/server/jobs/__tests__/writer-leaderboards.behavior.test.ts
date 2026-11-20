import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { withMetricExcludedUsers } from '~/server/jobs/leaderboard-board-query';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261120120000_writer_leaderboards/migration.sql'
);

const STORYTELLER = 10;
const OLD_HIT = 20;
const RELEASE_NOTES = 30;
const MUSER = 31;
const NEWCOMER = 40;
const NEWCOMER_FEW_READERS = 41;
const DORMANT_GUIDE = 50;
const READERS = Array.from({ length: 40 }, (_, i) => 1000 + i);
const HOST = 60;
const ANSWERERS = [61, 62, 63, 64, 65];
const EARLY = 66;
const COMMENTERS = [70, 71, 72];
const EXCLUDED_COMMENTER = 73;
const DELETED_COMMENTER = 74; // a deleted comment on the article, and a live one on an image with the same id
const HIDDEN_COMMENTER = 75;
const TOS_COMMENTER = 76;
// Categories the system assigned that differ from the author's pick.
const SYSTEM_MUSING_AUTHOR_NOTES = 32;
const SYSTEM_NOTES_AUTHOR_MUSING = 33;
const SYSTEM_GUIDE_AUTHOR_MUSING = 51;
const SYSTEM_MUSING_AUTHOR_GUIDE = 52;
// Articles the Writers board leaves out.
const UNRATED = 80;
const UNSCANNED = 81;
const BANNED = 82;
// One article each that every board would count but for one gate; PASSES_GATES is the same article with none.
const GATED = {
  unrated: 80,
  unscanned: 81,
  banned: 82,
  private: 83,
  tosViolation: 84,
  deletedOwner: 85,
  unlisted: 86,
};
const PASSES_GATES = 87;
const ANSWERS_GATED = 90; // answers each of those articles
const CITED_BY_EVERY_FIXTURE = 91; // cited by every gated article and by the one that passes
const UNCATEGORISED = 92;

type Row = { userId: number; position: number; score: number; metrics: Record<string, number> };

let db: PGlite;
const q = (sql: string, params?: unknown[]) => db.query(sql, params);

// What prepare-leaderboard does with a board's query: fill the token, then rank the `scores` CTE.
async function run(id: string, excludedUserIds: number[] = []) {
  const { rows } = await q(`SELECT query FROM "Leaderboard" WHERE id = $1`, [id]);
  const [{ query }] = rows as { query: string }[];
  const result = await q(`${withMetricExcludedUsers(query, excludedUserIds)}
    SELECT s."userId", ROUND(s.score)::int AS score, s.metrics,
      (row_number() OVER (ORDER BY s.score DESC))::int AS position
    FROM scores s ORDER BY position`);
  return result.rows as Row[];
}

const byUser = (rows: Row[], userId: number) => rows.find((r) => r.userId === userId);

beforeAll(async () => {
  db = new PGlite({ extensions: { citext } });
  await db.exec(`
    CREATE EXTENSION citext;
    CREATE TABLE "User" (
      id INT PRIMARY KEY, "isModerator" BOOLEAN DEFAULT false,
      "excludeFromLeaderboards" BOOLEAN NOT NULL DEFAULT false,
      "deletedAt" TIMESTAMP, "bannedAt" TIMESTAMP, "mutedAt" TIMESTAMP, "leaderboardShowcase" TEXT
    );
    CREATE TABLE "Leaderboard" (
      id TEXT PRIMARY KEY, index INT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
      "scoringDescription" TEXT NOT NULL, query TEXT NOT NULL, active BOOLEAN NOT NULL, public BOOLEAN NOT NULL,
      domain TEXT[] NOT NULL DEFAULT '{all}'
    );
    CREATE TABLE "LeaderboardResult" (
      "leaderboardId" TEXT REFERENCES "Leaderboard" (id) ON DELETE CASCADE, date DATE, "userId" INT,
      score INT, metrics JSONB, position INT
    );
    CREATE TABLE "UserRank" (
      "userId" INT PRIMARY KEY, "leaderboardRank" INT, "leaderboardId" TEXT, "leaderboardTitle" TEXT,
      "leaderboardCosmetic" TEXT
    );
    CREATE TABLE "LegendsBoardResult" ("userId" INT, "leaderboardId" TEXT, score INT, metrics JSONB, position INT);
    CREATE TABLE "KeyValue" (key TEXT PRIMARY KEY, value JSONB);
    CREATE TABLE "Cosmetic" (id SERIAL PRIMARY KEY, "leaderboardId" TEXT, "leaderboardPosition" INT, data JSONB);
    -- citext, as in production: an array of names is citext[], which does not compare with a text[] literal.
    CREATE TABLE "Tag" (id INT PRIMARY KEY, name CITEXT NOT NULL, "isCategory" BOOLEAN NOT NULL);
    CREATE TABLE "Article" (
      id INT PRIMARY KEY, "userId" INT NOT NULL, status TEXT NOT NULL, availability TEXT NOT NULL,
      unlisted BOOLEAN NOT NULL DEFAULT false, "tosViolation" BOOLEAN NOT NULL DEFAULT false,
      "publishedAt" TIMESTAMP, content TEXT NOT NULL DEFAULT '', "systemCategoryId" INT,
      ingestion TEXT NOT NULL DEFAULT 'Scanned', "nsfwLevel" INT NOT NULL DEFAULT 1
    );
    CREATE TABLE "TagsOnTags" ("fromTagId" INT, "toTagId" INT);
    CREATE TYPE "CommentEntityType" AS ENUM ('model', 'image', 'post', 'article');
    CREATE TABLE "CommentV3" (
      id SERIAL PRIMARY KEY, "entityType" "CommentEntityType" NOT NULL, "entityId" INT NOT NULL,
      "parentId" INT, "userId" INT NOT NULL, "deletedAt" TIMESTAMPTZ,
      "tosViolation" BOOLEAN NOT NULL DEFAULT false, hidden BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE "TagsOnArticle" ("articleId" INT, "tagId" INT);
    CREATE TABLE "ArticleMetric" (
      "articleId" INT, timeframe TEXT, "likeCount" INT, "heartCount" INT, "laughCount" INT,
      "cryCount" INT, "commentCount" INT, "viewCount" INT, "collectedCount" INT
    );
    CREATE TABLE "ArticleReaction" (
      id SERIAL, "articleId" INT, "userId" INT, reaction TEXT, "createdAt" TIMESTAMP
    );

    INSERT INTO "Leaderboard" VALUES ('writer', 7, 'Writers', '', '', 'SELECT 1', true, true, '{green,blue}');
    -- Categories are the children of the 'article category' system tag, whatever their isCategory says.
    INSERT INTO "Tag" VALUES (1, 'story', false), (2, 'announcement', false), (3, 'Generation Guide', false),
      (4, 'musing', false), (5, 'elf', false), (100, 'article category', false);
    INSERT INTO "TagsOnTags" VALUES (100, 1), (100, 2), (100, 3), (100, 4);
    INSERT INTO "User" (id) SELECT unnest(ARRAY[
      ${STORYTELLER}, ${OLD_HIT}, ${RELEASE_NOTES}, ${MUSER}, ${NEWCOMER}, ${NEWCOMER_FEW_READERS}, ${DORMANT_GUIDE}
    ]);

    INSERT INTO "Article" SELECT 100 + g, ${STORYTELLER}, 'Published', 'Public', false, false,
      now() - g * interval '7 days' FROM generate_series(0, 7) g;
    INSERT INTO "TagsOnArticle" SELECT 100 + g, t FROM generate_series(0, 7) g, unnest(ARRAY[1, 5]) t;

    INSERT INTO "Article" VALUES (200, ${OLD_HIT}, 'Published', 'Public', false, false, now() - interval '300 days'),
      (201, ${OLD_HIT}, 'Published', 'Public', false, false, now() - interval '20 days');
    INSERT INTO "TagsOnArticle" VALUES (200, 3), (201, 3);

    -- Same age and metrics for two users; one tagged announcement, one a musing. Plus a draft and an unlisted one.
    INSERT INTO "Article" VALUES (300, ${RELEASE_NOTES}, 'Published', 'Public', false, false, now() - interval '5 days'),
      (301, ${RELEASE_NOTES}, 'Draft', 'Public', false, false, NULL),
      (302, ${RELEASE_NOTES}, 'Published', 'Public', true, false, now() - interval '5 days'),
      (310, ${MUSER}, 'Published', 'Public', false, false, now() - interval '5 days');
    INSERT INTO "TagsOnArticle" VALUES (300, 2), (301, 2), (302, 2), (310, 4);

    INSERT INTO "Article" VALUES (400, ${NEWCOMER}, 'Published', 'Public', false, false, now() - interval '10 days'),
      (410, ${NEWCOMER_FEW_READERS}, 'Published', 'Public', false, false, now() - interval '10 days'),
      (500, ${DORMANT_GUIDE}, 'Published', 'Public', false, false, now() - interval '500 days');
    INSERT INTO "TagsOnArticle" VALUES (400, 1), (410, 1), (500, 3);

    -- A challenge 30 days old. Five people answer it later (one with their first article, one answering twice);
    -- the host's own follow-up and an answer published before the challenge do not count.
    INSERT INTO "User" (id) SELECT unnest(ARRAY[${HOST}, ${ANSWERERS.join(
    ','
  )}, ${EARLY}, ${COMMENTERS.join(
    ','
  )}, ${EXCLUDED_COMMENTER}, ${DELETED_COMMENTER}, ${HIDDEN_COMMENTER}, ${TOS_COMMENTER}]);
    INSERT INTO "Article" VALUES (600, ${HOST}, 'Published', 'Public', false, false, now() - interval '30 days', ''),
      (615, ${HOST}, 'Published', 'Public', false, false, now() - interval '10 days', '<a href="/articles/600">mine</a>'),
      (616, ${EARLY}, 'Published', 'Public', false, false, now() - interval '40 days', '<a href="/articles/600">early</a>');
    INSERT INTO "Article" SELECT 640 + i, u, 'Published', 'Public', false, false, now() - interval '20 days',
      '<a href="https://civitai.red/articles/600">my answer</a>'
    FROM unnest(ARRAY[${ANSWERERS.join(',')}]) WITH ORDINALITY AS x(u, i);
    INSERT INTO "Article" VALUES (630, ${
      ANSWERERS[1]
    }, 'Published', 'Public', false, false, now() - interval '18 days',
      '<a href="/articles/600">a second answer</a>');
    INSERT INTO "Article" SELECT 620 + i, u, 'Published', 'Public', false, false, now() - interval '200 days', ''
    FROM unnest(ARRAY[${ANSWERERS.slice(1).join(',')}]) WITH ORDINALITY AS x(u, i);
    INSERT INTO "TagsOnArticle" SELECT id, 4 FROM "Article" WHERE id >= 600;

    -- Three people comment (one twice), one of them in a reply, and the host replies; one commenter is
    -- metric-excluded and one comment was deleted. One answer also draws a comment, but nobody answers it.
    INSERT INTO "CommentV3" (id, "entityType", "entityId", "parentId", "userId", "deletedAt") VALUES
      (1, 'article', 600, NULL, ${COMMENTERS[0]}, NULL), (2, 'article', 600, NULL, ${
    COMMENTERS[0]
  }, NULL),
      (3, 'article', 600, NULL, ${COMMENTERS[1]}, NULL), (4, 'article', 600, 1, ${
    COMMENTERS[2]
  }, NULL),
      (5, 'article', 600, 1, ${HOST}, NULL), (6, 'article', 600, 4, ${HOST}, NULL),
      (7, 'article', 600, NULL, ${EXCLUDED_COMMENTER}, NULL), (8, 'article', 600, NULL, ${DELETED_COMMENTER}, now()),
      (9, 'article', 641, NULL, ${
        COMMENTERS[0]
      }, NULL), (10, 'image', 600, NULL, ${DELETED_COMMENTER}, NULL);
    -- A hidden comment and a ToS-violating one on the challenge.
    INSERT INTO "CommentV3" (id, "entityType", "entityId", "userId", hidden, "tosViolation") VALUES
      (11, 'article', 600, ${HIDDEN_COMMENTER}, true, false), (12, 'article', 600, ${TOS_COMMENTER}, false, true);
    -- On the recent guide: one commenter who counts, its author, a metric-excluded account, and a comment
    -- older than a year.
    INSERT INTO "CommentV3" (id, "entityType", "entityId", "userId", "createdAt") VALUES
      (20, 'article', 201, ${COMMENTERS[0]}, now()), (21, 'article', 201, ${OLD_HIT}, now()),
      (22, 'article', 201, ${EXCLUDED_COMMENTER}, now()),
      (23, 'article', 201, ${COMMENTERS[1]}, now() - interval '400 days');

    INSERT INTO "User" (id) VALUES (${SYSTEM_MUSING_AUTHOR_NOTES}), (${SYSTEM_NOTES_AUTHOR_MUSING}),
      (${SYSTEM_GUIDE_AUTHOR_MUSING}), (${SYSTEM_MUSING_AUTHOR_GUIDE});
    INSERT INTO "Article" (id, "userId", status, availability, "publishedAt", "systemCategoryId", ingestion, "nsfwLevel")
    VALUES (700, ${SYSTEM_MUSING_AUTHOR_NOTES}, 'Published', 'Public', now() - interval '5 days', 4, 'Scanned', 1),
      (701, ${SYSTEM_NOTES_AUTHOR_MUSING}, 'Published', 'Public', now() - interval '5 days', 2, 'Scanned', 1),
      (710, ${SYSTEM_GUIDE_AUTHOR_MUSING}, 'Published', 'Public', now() - interval '20 days', 3, 'Scanned', 1),
      (711, ${SYSTEM_MUSING_AUTHOR_GUIDE}, 'Published', 'Public', now() - interval '20 days', 4, 'Scanned', 1);
    INSERT INTO "TagsOnArticle" VALUES (700, 2), (701, 4), (710, 4), (711, 3);

    -- A recent guide by a first-time writer, with 30 readers and an answer: it would make every board.
    INSERT INTO "User" (id, "deletedAt", "bannedAt") VALUES
      (${GATED.unrated}, NULL, NULL), (${GATED.unscanned}, NULL, NULL), (${
    GATED.banned
  }, NULL, now()),
      (${GATED.private}, NULL, NULL), (${GATED.tosViolation}, NULL, NULL), (${
    GATED.deletedOwner
  }, now(), NULL),
      (${
        GATED.unlisted
      }, NULL, NULL), (${PASSES_GATES}, NULL, NULL), (${ANSWERS_GATED}, NULL, NULL),
      (${CITED_BY_EVERY_FIXTURE}, NULL, NULL), (${UNCATEGORISED}, NULL, NULL);
    INSERT INTO "Article" (id, "userId", status, availability, "publishedAt", content, "systemCategoryId") VALUES
      (900, ${CITED_BY_EVERY_FIXTURE}, 'Published', 'Public', now() - interval '30 days', '', 4),
      (920, ${UNCATEGORISED}, 'Published', 'Public', now() - interval '5 days', '', NULL);
    INSERT INTO "Article"
      (id, "userId", status, availability, unlisted, "tosViolation", "publishedAt", content, "systemCategoryId", ingestion, "nsfwLevel")
    SELECT 800 + u - 80, u, 'Published',
      CASE WHEN u = ${GATED.private} THEN 'Private' ELSE 'Public' END,
      u = ${GATED.unlisted}, u = ${
    GATED.tosViolation
  }, now() - interval '5 days', '<a href="/articles/900">answer</a>', 3,
      CASE WHEN u = ${GATED.unscanned} THEN 'Pending' ELSE 'Scanned' END,
      CASE WHEN u = ${GATED.unrated} THEN 0 ELSE 1 END
    FROM generate_series(80, 87) u;
    INSERT INTO "Article" (id, "userId", status, availability, "publishedAt", content, "systemCategoryId")
    SELECT 850 + g, ${ANSWERS_GATED}, 'Published', 'Public', now() - interval '2 days',
      '<a href="/articles/' || (800 + g) || '">answer</a>', 4
    FROM generate_series(0, 7) g;
    INSERT INTO "ArticleReaction" ("articleId", "userId", reaction, "createdAt")
    SELECT 800 + a, 4000 + r, 'Like', now() FROM generate_series(0, 7) a, generate_series(0, 29) r;
    -- A link whose number is past int4 must not break the board.
    INSERT INTO "Article" (id, "userId", status, availability, "publishedAt", content)
    VALUES (930, ${ANSWERS_GATED}, 'Published', 'Public', now() - interval '1 day', '<a href="/articles/99999999999">x</a>');
    -- The newcomer hearts their own article; it must not count as a reader.
    INSERT INTO "ArticleReaction" ("articleId", "userId", reaction, "createdAt") VALUES (400, ${NEWCOMER}, 'Heart', now());

    INSERT INTO "ArticleMetric"
    SELECT id, 'AllTime', 10, 5, 1, 0, 3, 400, 4 FROM "Article";
    UPDATE "ArticleMetric" SET "viewCount" = 30000, "collectedCount" = 500, "likeCount" = 300
    WHERE "articleId" IN (200, 500);

    -- The author hearts their own chapters; they must not count as a reader.
    INSERT INTO "ArticleReaction" ("articleId", "userId", reaction, "createdAt")
    SELECT 100 + c, r, 'Like', now() - interval '3 days'
    FROM generate_series(0, 7) c, unnest(ARRAY[${READERS.join(',')}]) r;
    INSERT INTO "ArticleReaction" ("articleId", "userId", reaction, "createdAt")
    SELECT 100 + c, ${STORYTELLER}, 'Heart', now() FROM generate_series(0, 7) c;
    INSERT INTO "ArticleReaction" ("articleId", "userId", reaction, "createdAt")
    SELECT 400, 2000 + g, 'Like', now() FROM generate_series(0, 29) g;
    INSERT INTO "ArticleReaction" ("articleId", "userId", reaction, "createdAt")
    SELECT 410, 3000 + g, 'Like', now() FROM generate_series(0, 9) g;
  `);
  await db.exec(readFileSync(MIGRATION, 'utf-8'));
});

describe('writer leaderboards migration', () => {
  it("stages the four boards hidden and unpopulated, after the existing boards, on the Writers board's domain", async () => {
    const { rows } = await q(
      `SELECT id, index, active, public, domain FROM "Leaderboard" WHERE id LIKE 'writer-%' ORDER BY index`
    );
    const staged = { active: false, public: false, domain: ['green', 'blue'] };
    expect(rows).toEqual([
      { id: 'writer-active', index: 8, ...staged },
      { id: 'writer-guide', index: 9, ...staged },
      { id: 'writer-rising', index: 10, ...staged },
      { id: 'writer-community', index: 11, ...staged },
    ]);
  });
});

describe('participants', () => {
  it("counts each commenter once and never the author's own comments or replies", async () => {
    const rows = await run('writer-active', [EXCLUDED_COMMENTER]);
    expect(byUser(rows, HOST)!.metrics.participants).toBe(COMMENTERS.length);
  });
});

describe('Community Builders', () => {
  it('counts each later article by someone else once, and first-time writers among them', async () => {
    const rows = await run('writer-community', [EXCLUDED_COMMENTER]);
    expect(rows[0].userId).toBe(HOST);
    expect(rows[0].metrics).toMatchObject({
      answers: ANSWERERS.length,
      firstTimers: 1,
      participants: COMMENTERS.length,
    });
  });

  it('drops answers from metric-excluded accounts', async () => {
    const rows = await run('writer-community', [EXCLUDED_COMMENTER, ANSWERERS[0]]);
    expect(byUser(rows, HOST)!.metrics.answers).toBe(ANSWERERS.length - 1);
  });

  it('leaves out a writer whose articles drew comments but no answers', async () => {
    const rows = await run('writer-community', [EXCLUDED_COMMENTER]);
    expect(byUser(rows, ANSWERERS[0])).toBeUndefined();
  });
});

describe('Active Writers', () => {
  it('ranks a writer publishing every week above an old hit', async () => {
    const rows = await run('writer-active');
    expect(rows[0].userId).toBe(STORYTELLER);
    expect(byUser(rows, STORYTELLER)!.score).toBeGreaterThan(byUser(rows, OLD_HIT)!.score);
  });

  it('gives release notes a quarter of the points and skips drafts and unlisted articles', async () => {
    const rows = await run('writer-active');
    const notes = byUser(rows, RELEASE_NOTES)!;
    const musing = byUser(rows, MUSER)!;
    expect(notes.metrics.articles).toBe(1);
    expect(Math.abs(notes.score * 4 - musing.score)).toBeLessThanOrEqual(4);
  });

  it('leaves out articles older than a year', async () => {
    const rows = await run('writer-active');
    expect(byUser(rows, DORMANT_GUIDE)).toBeUndefined();
  });

  it("judges release notes by the system category, not the author's pick", async () => {
    const rows = await run('writer-active');
    const musing = byUser(rows, MUSER)!.score;
    expect(byUser(rows, SYSTEM_MUSING_AUTHOR_NOTES)!.score).toBe(musing);
    expect(
      Math.abs(byUser(rows, SYSTEM_NOTES_AUTHOR_MUSING)!.score * 4 - musing)
    ).toBeLessThanOrEqual(4);
  });

  it('scores an article with no category in full', async () => {
    const rows = await run('writer-active');
    expect(byUser(rows, UNCATEGORISED)!.score).toBe(byUser(rows, MUSER)!.score);
  });
});

describe.each(['writer-active', 'writer-guide', 'writer-rising', 'writer-community'])(
  '%s gates',
  (board) => {
    it('counts an article that passes every gate', async () => {
      expect(byUser(await run(board), PASSES_GATES)).toBeDefined();
    });

    it.each(Object.entries(GATED))(
      'leaves out an article that fails one: %s',
      async (_, userId) => {
        expect(byUser(await run(board), userId)).toBeUndefined();
      }
    );
  }
);

describe('Community Builders answers', () => {
  it('counts only answers that pass the gates', async () => {
    const rows = await run('writer-community');
    expect(byUser(rows, PASSES_GATES)!.metrics.answers).toBe(1);
    expect(byUser(rows, CITED_BY_EVERY_FIXTURE)!.metrics.answers).toBe(1);
  });
});

describe('Guide Writers', () => {
  it('ranks guides of any age but needs a guide from the last year', async () => {
    const rows = await run('writer-guide');
    expect(rows[0].userId).toBe(OLD_HIT);
    expect(byUser(rows, DORMANT_GUIDE)).toBeUndefined();
  });

  it("counts only other people's comments from the past year, never metric-excluded accounts", async () => {
    const rows = await run('writer-guide', [EXCLUDED_COMMENTER]);
    expect(byUser(rows, OLD_HIT)!.metrics.participants).toBe(1);
  });

  it("counts a guide by its system category, not the author's pick", async () => {
    const rows = await run('writer-guide');
    expect(byUser(rows, SYSTEM_GUIDE_AUTHOR_MUSING)).toBeDefined();
    expect(byUser(rows, SYSTEM_MUSING_AUTHOR_GUIDE)).toBeUndefined();
  });
});

describe('Rising Writers', () => {
  it('ranks only writers whose first article is under 90 days old and who have 25 readers', async () => {
    const rows = await run('writer-rising');
    expect(byUser(rows, NEWCOMER)!.metrics).toEqual({ articles: 1, readers: 30 });
    expect(byUser(rows, NEWCOMER_FEW_READERS)).toBeUndefined();
    expect(byUser(rows, OLD_HIT)).toBeUndefined();
  });

  it('drops reactions from metric-excluded accounts', async () => {
    const rows = await run('writer-rising', [2000, 2001]);
    expect(byUser(rows, NEWCOMER)!.metrics.readers).toBe(28);
  });
});

// Runs last: it deletes the boards the suites above read.
describe('the rollback in the migration header', () => {
  const rollbackSql = () => {
    const lines = readFileSync(MIGRATION, 'utf-8').split('\n');
    const start = lines.indexOf('--   BEGIN;');
    const end = lines.indexOf('--   COMMIT;');
    return lines
      .slice(start, end + 1)
      .map((line) => line.replace(/^-- {3}/, ''))
      .join('\n');
  };
  const writerBoards = async () =>
    (await q(`SELECT id FROM "Leaderboard" WHERE id LIKE 'writer-%' ORDER BY id`)).rows;

  it('refuses while a badge for one of the boards exists, and changes nothing', async () => {
    await q(
      `INSERT INTO "Cosmetic" ("leaderboardId", "leaderboardPosition", data) VALUES ('writer-active', 10, '{}')`
    );
    await expect(db.exec(rollbackSql())).rejects.toThrow(
      'writer board badges exist: roll back their migration first'
    );
    await q('ROLLBACK');
    expect(await writerBoards()).toHaveLength(4);
    await q(`DELETE FROM "Cosmetic"`);
  });

  it('removes what the boards produced and rebuilds their ranks from the boards that remain', async () => {
    await db.exec(`
      INSERT INTO "LeaderboardResult" VALUES ('writer-active', current_date, ${STORYTELLER}, 900, '{}', 1);
      INSERT INTO "LeaderboardResult" VALUES ('writer', current_date, ${STORYTELLER}, 500, '{}', 5);
      INSERT INTO "Cosmetic" ("leaderboardId", "leaderboardPosition", data) VALUES ('writer', 10, '{"url": "bronze"}');
      INSERT INTO "UserRank" VALUES (${STORYTELLER}, 1, 'writer-active', 'Active Writers', NULL),
        (${OLD_HIT}, 3, 'writer', 'Writers', NULL);
      INSERT INTO "LegendsBoardResult" VALUES (${STORYTELLER}, 'writer-active', 10, '{}', 1),
        (${OLD_HIT}, 'writer', 10, '{}', 3);
      INSERT INTO "KeyValue" VALUES ('leaderboard:populated:writer-active', '"2026-10-22"'),
        ('leaderboard:populated:writer', '"2026-10-22"');
    `);

    await db.exec(rollbackSql());

    expect(await writerBoards()).toEqual([]);
    const results = await q(`SELECT DISTINCT "leaderboardId" FROM "LeaderboardResult"`);
    expect(results.rows).toEqual([{ leaderboardId: 'writer' }]);
    const ranks = await q(`SELECT * FROM "UserRank" ORDER BY "userId"`);
    expect(ranks.rows).toEqual([
      {
        userId: STORYTELLER,
        leaderboardRank: 5,
        leaderboardId: 'writer',
        leaderboardTitle: 'Writers',
        leaderboardCosmetic: 'bronze',
      },
      {
        userId: OLD_HIT,
        leaderboardRank: 3,
        leaderboardId: 'writer',
        leaderboardTitle: 'Writers',
        leaderboardCosmetic: null,
      },
    ]);
    const legends = await q(`SELECT DISTINCT "leaderboardId" FROM "LegendsBoardResult"`);
    expect(legends.rows).toEqual([{ leaderboardId: 'writer' }]);
    const keys = await q(`SELECT key FROM "KeyValue"`);
    expect(keys.rows).toEqual([{ key: 'leaderboard:populated:writer' }]);
  });
});
