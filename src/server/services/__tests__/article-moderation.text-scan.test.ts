import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RouteModule from '~/server/services/text-scan/route';

vi.mock('~/server/services/text-scan/route', async (importOriginal) => ({
  ...(await importOriginal<typeof RouteModule>()),
  submitTextModerationOrScan: vi.fn(),
}));
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

beforeEach(() => vi.clearAllMocks());

describe('articleModerationAdapter — text scan', () => {
  it('routes submit, keeping the XGuard call as the off/shadow path', async () => {
    vi.mocked(submitTextModerationOrScan).mockImplementation(async ({ xguard }) => xguard());
    vi.mocked(submitTextModeration).mockResolvedValue({ id: 'xg' } as never);
    expect(await articleModerationAdapter.submit({ entityId: 4, content: 'T body' })).toEqual({ id: 'xg' });
    expect(submitTextModerationOrScan).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Article', entityId: 4 })
    );
    expect(submitTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Article', entityId: 4, content: 'T body', labels: ['nsfw'] })
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
