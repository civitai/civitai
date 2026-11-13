import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

import { getArticleScanStatus } from '~/server/services/article.service';
import {
  ArticleStatus,
  EntityModerationStatus,
  ImageIngestionStatus,
} from '~/shared/utils/prisma/enums';

const mockDbRead = dbMock.dbRead;

const ARTICLE_ID = 34978;
const COVER_ID = 501;

const scannedCover = {
  id: COVER_ID,
  url: 'cover-key',
  ingestion: ImageIngestionStatus.Scanned,
  blockedFor: null,
  nsfwLevelLocked: false,
  scanJobs: null,
};

function givenArticle(
  article: { status: ArticleStatus; scheduledAt: Date | null },
  moderation: { status: EntityModerationStatus; blocked: boolean } | null = null
) {
  mockDbRead.imageConnection.findMany.mockResolvedValue([] as never);
  mockDbRead.article.findUnique.mockResolvedValue({
    title: 'New Stickers and other news',
    content: '<p>Some text</p>',
    coverId: COVER_ID,
    ...article,
  } as never);
  mockDbRead.entityModeration.findUnique.mockResolvedValue(
    (moderation ? { ...moderation, retryCount: 0, updatedAt: new Date() } : null) as never
  );
  mockDbRead.image.findUnique.mockResolvedValue(scannedCover as never);
}

describe('getArticleScanStatus text requirement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Drafts are not text-scanned until the save that makes them public, so no verdict ever
  // arrives; requiring one left the editor and article page polling "Scanning" forever.
  it('completes a draft whose images are scanned, with no text verdict', async () => {
    givenArticle({ status: ArticleStatus.Draft, scheduledAt: null });

    const status = await getArticleScanStatus({ id: ARTICLE_ID });

    expect(status.pending).toBe(0);
    expect(status.textModeration.required).toBe(false);
    expect(status.allComplete).toBe(true);
  });

  it.each([
    ['published', { status: ArticleStatus.Published, scheduledAt: null }],
    ['scheduled', { status: ArticleStatus.Draft, scheduledAt: new Date('2026-10-20T12:00:00Z') }],
    ['processing', { status: ArticleStatus.Processing, scheduledAt: null }],
  ])('keeps a %s article incomplete until its text verdict lands', async (_, article) => {
    givenArticle(article);

    const status = await getArticleScanStatus({ id: ARTICLE_ID });

    expect(status.textModeration.required).toBe(true);
    expect(status.allComplete).toBe(false);
  });

  // A blocked verdict is what unpublishes an article, so it must still reach the author.
  it('reports a blocked text verdict on an article it unpublished', async () => {
    givenArticle(
      { status: ArticleStatus.UnpublishedViolation, scheduledAt: null },
      { status: EntityModerationStatus.Succeeded, blocked: true }
    );

    const status = await getArticleScanStatus({ id: ARTICLE_ID });

    expect(status.textModeration).toMatchObject({ required: true, blocked: true });
    expect(status.allComplete).toBe(true);
  });

  // A draft that went non-public mid-scan has its row recorded Failed; it is not rescanned
  // until it goes public, so there is nothing for the author to retry.
  it('does not surface a failed scan on a draft', async () => {
    givenArticle(
      { status: ArticleStatus.Draft, scheduledAt: null },
      { status: EntityModerationStatus.Failed, blocked: false }
    );

    const status = await getArticleScanStatus({ id: ARTICLE_ID });

    expect(status.textModeration.required).toBe(false);
    expect(status.allComplete).toBe(true);
  });

  it('completes a published article once its text verdict lands', async () => {
    givenArticle(
      { status: ArticleStatus.Published, scheduledAt: null },
      { status: EntityModerationStatus.Succeeded, blocked: false }
    );

    expect((await getArticleScanStatus({ id: ARTICLE_ID })).allComplete).toBe(true);
  });

  // The fake returns every column whatever the select asks for, so pin the columns the
  // public check reads: without them every article would read as a draft in production.
  it('selects the columns the public check reads', async () => {
    givenArticle({ status: ArticleStatus.Published, scheduledAt: null });

    await getArticleScanStatus({ id: ARTICLE_ID });

    expect(mockDbRead.article.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ status: true, scheduledAt: true }),
      })
    );
  });
});
