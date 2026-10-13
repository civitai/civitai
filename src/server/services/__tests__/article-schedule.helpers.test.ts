import { describe, expect, it } from 'vitest';
import {
  getArticleScheduleError,
  getScheduledArticleGoLive,
} from '~/server/services/article-schedule.helpers';
import { ArticleIngestionStatus, ArticleStatus } from '~/shared/utils/prisma/enums';

const NOW = new Date('2026-10-20T16:00:00.000Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const neverPublished = { publishedAt: null, status: ArticleStatus.Draft };
const inGoodStanding = { bannedAt: null, muted: false, deletedAt: null };

describe('getArticleScheduleError', () => {
  it('accepts a never-published draft, and a new article, inside the window', () => {
    expect(getArticleScheduleError(neverPublished, minutes(60), NOW)).toBeNull();
    expect(getArticleScheduleError(null, minutes(60), NOW)).toBeNull();
  });

  it('refuses a date inside the minimum lead time or in the past', () => {
    expect(getArticleScheduleError(neverPublished, minutes(9), NOW)).toMatch(/at least 10 minutes/);
    expect(getArticleScheduleError(neverPublished, minutes(-5), NOW)).toMatch(
      /at least 10 minutes/
    );
    expect(getArticleScheduleError(neverPublished, minutes(10), NOW)).toBeNull();
  });

  it('refuses a date past the three-month horizon', () => {
    expect(
      getArticleScheduleError(neverPublished, new Date('2027-01-21T16:00:00.000Z'), NOW)
    ).toMatch(/more than 3 months/);
  });

  it('refuses an article that has been public, whatever its status now', () => {
    for (const article of [
      { publishedAt: minutes(-60), status: ArticleStatus.Draft },
      { publishedAt: minutes(-60), status: ArticleStatus.Unpublished },
      { publishedAt: null, status: ArticleStatus.Published },
      { publishedAt: null, status: ArticleStatus.Processing },
      { publishedAt: null, status: ArticleStatus.UnpublishedViolation },
    ])
      expect(getArticleScheduleError(article, minutes(60), NOW)).toMatch(/never been published/);
  });
});

describe('getScheduledArticleGoLive', () => {
  it.each([
    [ArticleIngestionStatus.Scanned, 'publish'],
    [ArticleIngestionStatus.Pending, 'process'],
    [ArticleIngestionStatus.Rescan, 'process'],
    [ArticleIngestionStatus.Blocked, 'fail'],
    [ArticleIngestionStatus.Error, 'fail'],
  ] as const)('%s -> %s', (ingestion, outcome) => {
    expect(getScheduledArticleGoLive(ingestion, inGoodStanding)).toBe(outcome);
  });

  it('covers every ingestion state', () => {
    for (const ingestion of Object.values(ArticleIngestionStatus))
      expect(['publish', 'process', 'fail']).toContain(
        getScheduledArticleGoLive(ingestion, inGoodStanding)
      );
  });

  it.each([
    ['banned', { ...inGoodStanding, bannedAt: NOW }],
    ['muted', { ...inGoodStanding, muted: true }],
    ['deleted', { ...inGoodStanding, deletedAt: NOW }],
  ])('withdraws a scanned article whose author is %s', (_label, author) => {
    expect(getScheduledArticleGoLive(ArticleIngestionStatus.Scanned, author)).toBe('withdraw');
  });
});
