import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATION = readFileSync(
  path.resolve(
    __dirname,
    '../../../../packages/civitai-db-schema/prisma/migrations/20261114150000_writer_leaderboard_drop_rating_gate/migration.sql'
  ),
  'utf8'
);

// The writer query as 20261114120000_writer_leaderboard_maturity_gate leaves it, byte for byte
// (CRLF line ends, tab indents). The md5 assertion below keeps this fixture honest.
const GATED_WRITER_QUERY = [
  'SELECT',
  '\t  u.id as "userId",',
  '\t  (',
  '\t    sqrt(greatest(sum(am."viewCount"),1)) * 0.5 +',
  '\t    sqrt(greatest(SUM(am."likeCount" + am."heartCount" + am."laughCount" + am."cryCount"),1)) * 7 +',
  '\t    sqrt(greatest(SUM(am."collectedCount"),1)) * 10',
  '\t  ) * 100 as score,',
  '\t  jsonb_build_object(',
  `\t    'viewCount', SUM(am."viewCount"),`,
  `\t    'bookmark', SUM(am."collectedCount"),`,
  `\t    'reactionCount', SUM(am."likeCount" + am."heartCount" + am."laughCount" + am."cryCount")`,
  '\t\t) as metrics',
  '\tFROM "ArticleMetric" am',
  '\tJOIN "Article" a ON a.id = am."articleId"',
  '\tJOIN "User" u ON u.id = a."userId"',
  '\tWHERE',
  `\t  am.timeframe = 'AllTime'`,
  `\t  AND a.status = 'Published'`,
  `\t  AND a."publishedAt" BETWEEN current_date - INTERVAL '30 days' AND now()`,
  '\t  AND u."deletedAt" IS NULL AND u."bannedAt" IS NULL AND u.id > 0',
  `\t  AND a.ingestion = 'Scanned'`,
  '\t  AND NOT a."tosViolation"',
  '\t  AND NOT a.unlisted',
  `\t  AND a.availability <> 'Private'`,
  '\t  AND a."nsfwLevel" <> 0 AND (a."nsfwLevel" & ~3) = 0',
  '\tGROUP BY u.id',
].join('\r\n');

const SCHEMA = `
  CREATE TABLE "Leaderboard" (id text PRIMARY KEY, query text NOT NULL);
  CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp, "bannedAt" timestamp);
  CREATE TABLE "Article" (
    id int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL, "publishedAt" timestamp,
    nsfw boolean NOT NULL DEFAULT false, "nsfwLevel" int NOT NULL, ingestion text NOT NULL,
    "tosViolation" boolean NOT NULL, unlisted boolean NOT NULL, availability text NOT NULL
  );
  CREATE TABLE "ArticleMetric" (
    "articleId" int NOT NULL, timeframe text NOT NULL, "viewCount" int NOT NULL DEFAULT 0,
    "likeCount" int NOT NULL DEFAULT 0, "heartCount" int NOT NULL DEFAULT 0,
    "laughCount" int NOT NULL DEFAULT 0, "cryCount" int NOT NULL DEFAULT 0,
    "collectedCount" int NOT NULL DEFAULT 0
  );
`;

const HUGE = { views: 1_000_000, likes: 10000, bookmarks: 10000 };
type ArticleFixture = {
  id: number;
  userId: number;
  nsfwLevel?: number;
  ingestion?: string;
  tosViolation?: boolean;
  unlisted?: boolean;
  availability?: string;
  userBanned?: boolean;
  views?: number;
  likes?: number;
  bookmarks?: number;
};

const ARTICLES: ArticleFixture[] = [
  { id: 1, userId: 10, views: 100, likes: 49 },
  { id: 2, userId: 11, bookmarks: 100, nsfwLevel: 2 },
  // A writer with one PG article and one X article now ranks on both.
  { id: 3, userId: 12, views: 400 },
  { id: 4, userId: 12, nsfwLevel: 8, ...HUGE },
  // R, X, XXX and a PG-13|R article: each scores once the rating cap is gone.
  { id: 5, userId: 30, nsfwLevel: 4, ...HUGE },
  { id: 6, userId: 31, nsfwLevel: 8, ...HUGE },
  { id: 7, userId: 32, nsfwLevel: 16, ...HUGE },
  { id: 8, userId: 33, nsfwLevel: 2 | 4, ...HUGE },
  // Each of these would top the board if it counted.
  { id: 9, userId: 34, nsfwLevel: 0, ...HUGE },
  { id: 10, userId: 35, ingestion: 'Pending', ...HUGE },
  { id: 11, userId: 36, tosViolation: true, ...HUGE },
  { id: 12, userId: 37, unlisted: true, ...HUGE },
  { id: 13, userId: 38, availability: 'Private', ...HUGE },
  { id: 14, userId: 39, userBanned: true, ...HUGE },
];
const MATURE_ONLY = [30, 31, 32, 33];

async function seed(pg: PGlite, query: string) {
  await pg.exec(SCHEMA);
  await pg.query(`INSERT INTO "Leaderboard" VALUES ('writer', $1)`, [query]);
  for (const a of ARTICLES) {
    await pg.query(
      `INSERT INTO "User" VALUES ($1, NULL, CASE WHEN $2 THEN now() END) ON CONFLICT DO NOTHING`,
      [a.userId, a.userBanned ?? false]
    );
    await pg.query(
      `INSERT INTO "Article" (id, "userId", status, "publishedAt", "nsfwLevel", ingestion, "tosViolation", unlisted, availability)
       VALUES ($1, $2, 'Published', now() - interval '1 day', $3, $4, $5, $6, $7)`,
      [
        a.id,
        a.userId,
        a.nsfwLevel ?? 1,
        a.ingestion ?? 'Scanned',
        a.tosViolation ?? false,
        a.unlisted ?? false,
        a.availability ?? 'Public',
      ]
    );
    await pg.query(
      `INSERT INTO "ArticleMetric" ("articleId", timeframe, "viewCount", "likeCount", "collectedCount")
       VALUES ($1, 'AllTime', $2, $3, $4)`,
      [a.id, a.views ?? 0, a.likes ?? 0, a.bookmarks ?? 0]
    );
  }
}

async function writerQuery(pg: PGlite) {
  const { rows } = await pg.query<{ query: string }>(
    `SELECT query FROM "Leaderboard" WHERE id = 'writer'`
  );
  return rows[0].query;
}

/** The board's query as prepare-leaderboard's defaultLeadboardPopulation wraps it. */
async function standings(pg: PGlite) {
  const query = await writerQuery(pg);
  const { rows } = await pg.query<{ userId: number; score: number }>(
    `WITH scores AS (${query}) SELECT "userId", ROUND(score)::int AS score FROM scores ORDER BY score DESC, "userId"`
  );
  return rows.map((r) => [r.userId, r.score]);
}

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

describe('writer leaderboard drop rating gate migration', () => {
  const db = { pg: null as unknown as PGlite };
  let before: (number | string)[][];

  beforeAll(async () => {
    db.pg = new PGlite();
    await seed(db.pg, GATED_WRITER_QUERY);
    before = await standings(db.pg);
    await db.pg.exec(MIGRATION);
  });

  afterAll(async () => {
    await db.pg.close();
  });

  it('starts from the maturity-gated query, which leaves mature-only writers off the board', () => {
    expect(md5(GATED_WRITER_QUERY)).toBe('fad555977f62a2b5773ddf89379e544b');
    const ranked = before.map(([userId]) => userId);
    for (const userId of MATURE_ONLY) expect(ranked).not.toContain(userId);
  });

  it('ranks rated articles of every rating; unrated, unscanned, ToS, unlisted, Private and banned stay out', async () => {
    // (sqrt(views)*0.5 + sqrt(reactions)*7 + sqrt(bookmarks)*10) * 100; empty terms floor at 1.
    expect(await standings(db.pg)).toEqual([
      [12, 220010],
      [30, 220000],
      [31, 220000],
      [32, 220000],
      [33, 220000],
      [11, 10750],
      [10, 6400],
    ]);
  });

  it('changes only the rating line', async () => {
    const after = (await writerQuery(db.pg)).split('\r\n');
    const gated = GATED_WRITER_QUERY.split('\r\n');
    expect(gated.filter((l) => !after.includes(l))).toEqual([
      '\t  AND a."nsfwLevel" <> 0 AND (a."nsfwLevel" & ~3) = 0',
    ]);
    expect(after.filter((l) => !gated.includes(l))).toEqual(['\t  AND a."nsfwLevel" <> 0']);
  });

  it('is idempotent: a re-run leaves the fixed query as it is', async () => {
    const once = await writerQuery(db.pg);
    await db.pg.exec(MIGRATION);
    expect(await writerQuery(db.pg)).toBe(once);
  });
});

describe('writer leaderboard drop rating gate migration preconditions', () => {
  it('refuses to touch a writer query that differs from the reviewed gated text', async () => {
    const pg = new PGlite();
    try {
      const edited = GATED_WRITER_QUERY.replace('* 10', '* 12');
      await seed(pg, edited);
      await expect(pg.exec(MIGRATION)).rejects.toThrow(/differs from the reviewed text/);
      await pg.exec('ROLLBACK');
      expect(await writerQuery(pg)).toBe(edited);
    } finally {
      await pg.close();
    }
  });
});
