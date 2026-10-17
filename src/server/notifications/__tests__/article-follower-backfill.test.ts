import { describe, expect, it } from 'vitest';
import {
  backfillArticleFollowerNotices,
  type BackfillArticleResult,
  type BackfillDeps,
} from '~/server/notifications/article-follower-backfill';
import type {
  NotificationPendingRow,
  NotificationSingleRow,
} from '~/server/schema/notification.schema';

const NOW = new Date('2026-10-16T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

const row = (articleId: number, userId: number): NotificationSingleRow => ({
  key: `new-article-from-following:${articleId}`,
  userId,
  type: 'new-article-from-following',
  details: { articleId, articleTitle: `A${articleId}`, username: 'author', articleCategory: null },
});

function harness({
  articles = [] as { id: number; publishedAt: Date | null }[],
  rows = [] as NotificationSingleRow[],
  existingKeys = [] as string[],
} = {}) {
  const sent: NotificationPendingRow[][] = [];
  const logged: BackfillArticleResult[] = [];
  const queries: string[] = [];
  const deps: BackfillDeps = {
    readArticles: async (ids) => articles.filter((a) => ids.includes(a.id)),
    readRows: async (sql) => {
      queries.push(sql);
      return rows;
    },
    keyExists: async (key) => existingKeys.includes(key),
    send: async (r) => {
      sent.push(r);
    },
    log: (r) => logged.push(r),
    now: () => NOW,
  };
  return { deps, sent, logged, queries };
}

const outcomes = (results: BackfillArticleResult[]) =>
  Object.fromEntries(results.map((r) => [r.articleId, r.outcome]));

describe('backfillArticleFollowerNotices', () => {
  const recent = { id: 11, publishedAt: daysAgo(2) };

  it('a dry run reports what it would send and sends nothing', async () => {
    const h = harness({ articles: [recent], rows: [row(11, 201), row(11, 202)] });
    const results = await backfillArticleFollowerNotices(
      { articleIds: [11], maxAgeDays: 7, execute: false },
      h.deps
    );

    expect(results).toEqual([
      {
        articleId: 11,
        key: 'new-article-from-following:11',
        recipients: 2,
        keyExists: false,
        outcome: 'would-send',
      },
    ]);
    expect(h.sent).toEqual([]);
  });

  it('execute sends one row per article under the processor key, its category, and each user once', async () => {
    const h = harness({
      articles: [recent],
      rows: [row(11, 201), row(11, 202), row(11, 201)],
    });
    await backfillArticleFollowerNotices(
      { articleIds: [11], maxAgeDays: 7, execute: true },
      h.deps
    );

    expect(h.sent).toEqual([
      [
        {
          key: 'new-article-from-following:11',
          type: 'new-article-from-following',
          category: 'Update',
          details: row(11, 201).details,
          dedupeKey: null,
          users: [201, 202],
        },
      ],
    ]);
  });

  it('skips a key that already exists, so a re-run sends nothing', async () => {
    const h = harness({
      articles: [recent],
      rows: [row(11, 201)],
      existingKeys: ['new-article-from-following:11'],
    });
    const results = await backfillArticleFollowerNotices(
      { articleIds: [11], maxAgeDays: 7, execute: true },
      h.deps
    );

    expect(outcomes(results)).toEqual({ 11: 'skipped-existing' });
    expect(h.sent).toEqual([]);
  });

  it('resendExisting tops up an existing key', async () => {
    const h = harness({
      articles: [recent],
      rows: [row(11, 201)],
      existingKeys: ['new-article-from-following:11'],
    });
    const results = await backfillArticleFollowerNotices(
      { articleIds: [11], maxAgeDays: 7, execute: true, resendExisting: true },
      h.deps
    );

    expect(outcomes(results)).toEqual({ 11: 'sent' });
    expect(h.sent).toHaveLength(1);
  });

  it('names why an article sends nothing: not found, too old, or no eligible recipients', async () => {
    const h = harness({
      articles: [
        { id: 12, publishedAt: daysAgo(8) },
        { id: 13, publishedAt: daysAgo(1) },
        { id: 14, publishedAt: null },
      ],
      // A row for the too-old article proves the age check does not depend on the query's own cap.
      rows: [row(12, 201)],
    });
    const results = await backfillArticleFollowerNotices(
      { articleIds: [99, 12, 13, 14], maxAgeDays: 7, execute: true },
      h.deps
    );

    expect(outcomes(results)).toEqual({
      99: 'not-found',
      12: 'too-old',
      13: 'no-recipients',
      14: 'too-old',
    });
    expect(h.sent).toEqual([]);
  });

  it('logs one line per article, with its recipient count', async () => {
    const h = harness({
      articles: [recent, { id: 13, publishedAt: daysAgo(1) }],
      rows: [row(11, 201), row(11, 202)],
    });
    await backfillArticleFollowerNotices(
      { articleIds: [11, 13, 11], maxAgeDays: 7, execute: false },
      h.deps
    );

    expect(h.logged.map((r) => [r.articleId, r.recipients, r.outcome])).toEqual([
      [11, 2, 'would-send'],
      [13, 0, 'no-recipients'],
    ]);
  });

  it('reads recipients through the processor query, scoped to the ids and the age cap', async () => {
    const h = harness({ articles: [recent] });
    await backfillArticleFollowerNotices(
      { articleIds: [11], maxAgeDays: 5, execute: false },
      h.deps
    );

    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]).toMatch(
      /a\.id IN \(11\)\s+AND a\."publishedAt" > now\(\) - INTERVAL '5 days'/
    );
  });
});
