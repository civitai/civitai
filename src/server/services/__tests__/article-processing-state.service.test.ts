import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';

const mockDbRead = dbMock.dbRead;

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getDbWithoutLag: vi.fn(async () => mockDbRead),
}));

import {
  getPublishedArticleIngestion,
  isArticleProcessing,
} from '~/server/services/article.service';
import { ArticleIngestionStatus, ArticleStatus } from '~/shared/utils/prisma/enums';

const ARTICLE_ID = 34978;

/**
 * What a non-owner is told about an article `getArticleById` refused them.
 *
 * The mapping is the whole point: `getArticleById` gates non-owners on `ingestion = Scanned`, so
 * every other state is a refusal, and only some of those are worth asking a reader to wait for.
 * Getting it wrong is not cosmetic in either direction — promising a wait for `Blocked` strands
 * the reader on a page that never resolves, and refusing one for `Pending` reproduces the hard
 * 404 that sent published articles to 404 during the Sep 2026 scan incident.
 */
describe('article processing state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads only articles that are published for everyone', async () => {
    mockDbRead.article.findFirst.mockResolvedValue(null as never);

    await getPublishedArticleIngestion(ARTICLE_ID);

    expect(mockDbRead.article.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: ARTICLE_ID,
          publishedAt: { not: null },
          status: ArticleStatus.Published,
        },
      })
    );
  });

  it('returns null for an article that is not published — a draft is not "processing"', async () => {
    mockDbRead.article.findFirst.mockResolvedValue(null as never);

    expect(await getPublishedArticleIngestion(ARTICLE_ID)).toBeNull();
    expect(await isArticleProcessing({ id: ARTICLE_ID })).toBe(false);
  });

  // Pending is the publish window a notification links straight into. Rescan is the same window
  // re-entered by an edit, which is how an author 404s their own live article to the public.
  it.each([ArticleIngestionStatus.Pending, ArticleIngestionStatus.Rescan])(
    'treats %s as processing — it resolves on its own',
    async (ingestion) => {
      mockDbRead.article.findFirst.mockResolvedValue({ ingestion } as never);

      expect(await isArticleProcessing({ id: ARTICLE_ID })).toBe(true);
    }
  );

  // Scanned means getArticleById refused for some other reason (blocked by the author, say), so
  // there is nothing to wait for and the viewer should get the 404 they got before.
  it.each([
    ArticleIngestionStatus.Scanned,
    ArticleIngestionStatus.Blocked,
    ArticleIngestionStatus.Error,
  ])('does not promise a wait for %s', async (ingestion) => {
    mockDbRead.article.findFirst.mockResolvedValue({ ingestion } as never);

    expect(await isArticleProcessing({ id: ARTICLE_ID })).toBe(false);
  });
});
