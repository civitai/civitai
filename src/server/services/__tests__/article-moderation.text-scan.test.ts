import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as RouteModule from '~/server/services/text-scan/route';

vi.mock('~/server/services/text-scan/route', async (importOriginal) => ({
  ...(await importOriginal<typeof RouteModule>()),
  submitTextModerationOrScan: vi.fn(),
}));
// Hand-listed: the real module pulls nsfwLevels.service, whose search-index graph builds clients at load.
vi.mock('~/server/services/text-scan/rated-entities', () => ({
  applyRatingFloor: vi.fn(async () => ({ deferredRatingNotice: null })),
}));
// Hand-listed, as the existing adapter suites do: each real module drags in search-index or notifications.
vi.mock('~/server/services/text-moderation.service', () => ({ submitTextModeration: vi.fn() }));
vi.mock('~/server/services/article.service', () => ({ recomputeArticleIngestion: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/nsfwLevels.service', () => ({ updateArticleNsfwLevels: vi.fn() }));

const { articleModerationAdapter } = await import('~/server/services/article-moderation.adapter');
const { submitTextModerationOrScan } = await import('~/server/services/text-scan/route');
const { applyRatingFloor } = await import('~/server/services/text-scan/rated-entities');
const { submitTextModeration } = await import('~/server/services/text-moderation.service');
const { recomputeArticleIngestion } = await import('~/server/services/article.service');
const { TEXT_SCAN_ENTITY_NOT_PUBLIC } = await import('~/server/services/text-scan/route');

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.article.findUnique.mockResolvedValue({ status: 'Published', scheduledAt: null });
});

describe('articleModerationAdapter — text scan', () => {
  it('routes submit, keeping the XGuard call as the off/shadow path', async () => {
    vi.mocked(submitTextModerationOrScan).mockImplementation(async ({ xguard }) => xguard());
    vi.mocked(submitTextModeration).mockResolvedValue({ id: 'xg' } as never);
    expect(await articleModerationAdapter.submit({ entityId: 4, content: 'T body' })).toEqual({
      id: 'xg',
    });
    expect(submitTextModerationOrScan).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Article', entityId: 4, fromRetry: true })
    );
    expect(submitTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'Article',
        entityId: 4,
        content: 'T body',
        labels: ['nsfw'],
      })
    );
    // A retry must count against the cap, not reset it.
    expect(vi.mocked(submitTextModeration).mock.calls[0][0]).not.toHaveProperty('rearmRetries');
  });

  it('parks a draft on retry without scanning it on either path', async () => {
    dbMock.dbWrite.article.findUnique.mockResolvedValue({ status: 'Draft', scheduledAt: null });

    expect(await articleModerationAdapter.submit({ entityId: 4, content: 'T body' })).toBe(
      TEXT_SCAN_ENTITY_NOT_PUBLIC
    );
    expect(submitTextModerationOrScan).not.toHaveBeenCalled();
    expect(submitTextModeration).not.toHaveBeenCalled();
  });

  it.each([
    ['processing', { status: 'Processing', scheduledAt: null }],
    ['scheduled', { status: 'Draft', scheduledAt: new Date('2099-01-01') }],
    // A deleted article is left to the route, which reports it gone so the cron drops the row.
    ['missing', null],
  ])('submits a %s article on retry', async (_name, row) => {
    dbMock.dbWrite.article.findUnique.mockResolvedValue(row);
    vi.mocked(submitTextModerationOrScan).mockResolvedValue({ id: 'wf' });

    expect(await articleModerationAdapter.submit({ entityId: 4, content: 'T body' })).toEqual({
      id: 'wf',
    });
    expect(submitTextModerationOrScan).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ entityType: 'Article', entityId: 4, fromRetry: true })
    );
  });

  it('applies the floor, then advances ingestion', async () => {
    const args = {
      entityId: 4,
      workflowId: 'wf',
      outcome: { triggeredLabels: [], nsfwLevel: 4 },
      subject: { fields: [], declared: {} },
    };
    await articleModerationAdapter.applyTextScan!(args as never);
    expect(applyRatingFloor).toHaveBeenCalledWith('Article', args);
    expect(recomputeArticleIngestion).toHaveBeenCalledWith(4);
    expect(vi.mocked(applyRatingFloor).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(recomputeArticleIngestion).mock.invocationCallOrder[0]
    );
  });
});
