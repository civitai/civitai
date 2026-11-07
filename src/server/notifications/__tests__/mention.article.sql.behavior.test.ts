import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ARTICLE_MENTION_CAP,
  articleMentionsSql,
  mentionNotifications,
} from '~/server/notifications/mention.notifications';

/**
 * Who an article @mention notifies. Only a live, public article tells anyone; the author must be in
 * good standing; the recipient must be able to open it at their browsing level.
 */
const AUTHOR = 1;
// Relative to the clock, because the 30-day window in the query is.
const LAST_SENT = new Date(Date.now() - 60 * 60_000).toISOString();
const AFTER = `now() - interval '1 minute'`;
const BEFORE = `now() - interval '2 hours'`;

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    SET TimeZone = 'UTC';
    CREATE TABLE "User" (
      id int PRIMARY KEY, username text, "bannedAt" timestamp(3), "deletedAt" timestamp(3),
      muted boolean NOT NULL DEFAULT false, "browsingLevel" int NOT NULL DEFAULT 1
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "userId" int NOT NULL, title text NOT NULL, content text NOT NULL,
      status text NOT NULL DEFAULT 'Published', "publishedAt" timestamp(3),
      "updatedAt" timestamp(3), "contentScannedAt" timestamp(3),
      "tosViolation" boolean NOT NULL DEFAULT false, unlisted boolean NOT NULL DEFAULT false,
      availability text NOT NULL DEFAULT 'Public', "nsfwLevel" int NOT NULL DEFAULT 1,
      ingestion text NOT NULL DEFAULT 'Scanned'
    );
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type text);
    CREATE TABLE "UserNotificationSettings" ("userId" int, type text);
  `);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`
    TRUNCATE "User", "Article", "UserEngagement", "UserNotificationSettings";
    INSERT INTO "User" (id, username) SELECT g, 'u' || g FROM generate_series(1, 20) g;
  `);
});

const mention = (id: number) =>
  `<span data-type="mention" data-id="mention:${id}" data-label="u${id}">@u${id}</span>`;

/** A live public article by AUTHOR, published just after LAST_SENT, naming `ids`. */
const article = (ids: number[], set: Record<string, string> = {}) => {
  const cols: Record<string, string> = {
    id: '1',
    '"userId"': String(AUTHOR),
    title: `'Hello'`,
    content: `'<p>${ids.map(mention).join(' ')}</p>'`,
    '"publishedAt"': AFTER,
    '"updatedAt"': AFTER,
    ...set,
  };
  return db.exec(
    `INSERT INTO "Article" (${Object.keys(cols).join(', ')}) VALUES (${Object.values(cols).join(
      ', '
    )})`
  );
};

const recipients = async () => {
  const { rows } = await db.query<{
    ownerId: number;
    actorId: number;
    details: Record<string, unknown>;
  }>(articleMentionsSql(LAST_SENT));
  return rows.map((r) => r.ownerId).sort((a, b) => a - b);
};

describe('article @mentions', () => {
  it('a newly published article notifies each person it names, once', async () => {
    await article([2, 3, 2]);
    const { rows } = await db.query<{
      ownerId: number;
      actorId: number;
      details: Record<string, unknown>;
    }>(articleMentionsSql(LAST_SENT));
    expect(rows.map((r) => r.ownerId).sort((a, b) => a - b)).toEqual([2, 3]);
    expect(rows[0].actorId).toBe(AUTHOR);
    expect(rows[0].details).toMatchObject({
      mentionedIn: 'article',
      articleId: 1,
      articleTitle: 'Hello',
      username: 'u1',
    });
  });

  it.each([
    ['a scheduled draft', { status: `'Draft'`, '"publishedAt"': 'NULL' }],
    ['a once-published article moved back to Draft', { status: `'Draft'` }],
    ['an edit still waiting on its re-scan', { ingestion: `'Rescan'` }],
    ['an edit whose re-scan blocked it', { ingestion: `'Blocked'` }],
    ['an article still being scanned', { status: `'Processing'` }],
    ['an unpublished article', { status: `'Unpublished'` }],
    ['an article removed for a violation', { '"tosViolation"': 'true' }],
    ['an unlisted article', { unlisted: 'true' }],
    ['a Private article', { availability: `'Private'` }],
    ['an article with a future publishedAt', { '"publishedAt"': `now() + interval '1 day'` }],
  ])('%s notifies nobody', async (_, set) => {
    await article([2], set);
    expect(await recipients()).toEqual([]);
  });

  it('an author who is banned or muted notifies nobody', async () => {
    await db.exec(`UPDATE "User" SET "bannedAt" = now() WHERE id = ${AUTHOR}`);
    await article([2]);
    expect(await recipients()).toEqual([]);
    await db.exec(`UPDATE "User" SET "bannedAt" = NULL, muted = true WHERE id = ${AUTHOR}`);
    expect(await recipients()).toEqual([]);
  });

  it('skips banned and deleted recipients, and the author naming themself', async () => {
    await db.exec(`UPDATE "User" SET "bannedAt" = now() WHERE id = 2`);
    await db.exec(`UPDATE "User" SET "deletedAt" = now() WHERE id = 3`);
    await article([AUTHOR, 2, 3, 4]);
    expect(await recipients()).toEqual([4]);
  });

  it('skips a block either way, and anyone who turned mention notifications off', async () => {
    await db.exec(`
      INSERT INTO "UserEngagement" VALUES (2, ${AUTHOR}, 'Block'), (${AUTHOR}, 3, 'Block');
      INSERT INTO "UserNotificationSettings" VALUES (4, 'new-mention');
    `);
    await article([2, 3, 4, 5]);
    expect(await recipients()).toEqual([5]);
  });

  it('only tells a recipient whose browsing level can open the article', async () => {
    await db.exec(`UPDATE "User" SET "browsingLevel" = 31 WHERE id = 3`);
    await article([2, 3], { '"nsfwLevel"': '16' });
    expect(await recipients()).toEqual([3]);
  });

  it('an article untouched since the last run is not re-read', async () => {
    await article([2], { '"publishedAt"': BEFORE, '"updatedAt"': BEFORE });
    expect(await recipients()).toEqual([]);
  });

  it('an edit re-reads an article published within the window', async () => {
    await article([2], { '"publishedAt"': `now() - interval '20 days'` });
    expect(await recipients()).toEqual([2]);
  });

  it('a re-scan that brings an edited article back live re-reads it', async () => {
    await article([2], {
      '"publishedAt"': `now() - interval '20 days'`,
      '"updatedAt"': BEFORE,
      '"contentScannedAt"': AFTER,
    });
    expect(await recipients()).toEqual([2]);
  });

  it('an edit to an article published before the window notifies nobody', async () => {
    await article([2], { '"publishedAt"': `now() - interval '40 days'` });
    expect(await recipients()).toEqual([]);
  });

  it(`notifies at most the first ${ARTICLE_MENTION_CAP} people named, in document order`, async () => {
    const named = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4];
    await article([15, ...named]);
    expect(await recipients()).toEqual(named.slice(0, ARTICLE_MENTION_CAP).sort((a, b) => a - b));
  });

  it('names that cannot be told do not use up the cap', async () => {
    await db.exec(`UPDATE "User" SET "bannedAt" = now() WHERE id = 2`);
    const named = [AUTHOR, 2, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6];
    await article(named);
    expect(await recipients()).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });
});

describe('article @mention message', () => {
  type Def = {
    prepareMessage: (n: { details: Record<string, unknown> }) => { message: string; url: string };
    prepareQuery: (args: { lastSent: string }) => string;
  };
  const def = (mentionNotifications as unknown as Record<string, Def>)['new-mention'];

  it('names the article and links to it', () => {
    expect(
      def.prepareMessage({
        details: { mentionedIn: 'article', articleId: 7, articleTitle: 'Hi', username: 'bob' },
      })
    ).toEqual({ message: 'bob mentioned you in the article "Hi"', url: '/articles/7' });
  });

  it('is keyed per article, so an edit only reaches people not told yet', () => {
    const sql = def.prepareQuery({ lastSent: LAST_SENT });
    expect(sql).toContain(`when details->>'mentionedIn' = 'article' then 'article:'`);
    expect(sql).toContain(`details->>'articleId')`);
  });
});

// If you are about to change the trigger expression or drop the status filter: the planner only uses
// the hand-applied index when both match it verbatim, and otherwise every run scans all articles.
describe('article @mention scan stays on its index', () => {
  it('uses the expression and predicate of "Article_mention_scan_idx"', () => {
    const migration = readFileSync(
      'packages/civitai-db-schema/prisma/migrations/20261228120000_article_mention_scan_idx/migration.sql',
      'utf8'
    );
    const [, expression, predicate] =
      /ON "Article" \((GREATEST\(.*\))\)\s+WHERE (.*);/.exec(migration) ?? [];
    const sql = articleMentionsSql(LAST_SENT);
    expect(sql).toContain(expression.replace(/"(\w+)"/g, 'a."$1"'));
    expect(sql).toContain(`a.${predicate}`);
  });
});
