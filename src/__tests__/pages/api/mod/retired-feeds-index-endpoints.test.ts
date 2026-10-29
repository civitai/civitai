import type { NextApiRequest, NextApiResponse } from 'next';
import type * as RetiredIndexes from '~/server/search-index/retired-indexes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The mod and admin endpoints that read or write the feeds index (`metrics_images_v1`). Retired, the
// index is a frozen snapshot on a server that may already be shut down: an endpoint that selects
// from it acts on stale moderation state, and one that writes to it first can throw before its
// database write.

const m = vi.hoisted(() => ({
  retired: { metrics: true },
  getImagesFromSearch: vi.fn(),
  dropBlockedImageDeleteQueue: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
  trackModActivity: vi.fn(),
  updateDocs: vi.fn(),
  metricsIndex: vi.fn(),
  imagesSearch: vi.fn(),
  dataProcessor: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  ModEndpoint: (handler: unknown) => handler,
  WebhookEndpoint: (handler: unknown) => handler,
}));

// Retired by default; the un-retired case shows what the endpoint does once it reaches its query.
vi.mock('~/server/search-index/retired-indexes', async (importOriginal) => {
  const actual = await importOriginal<typeof RetiredIndexes>();
  return {
    ...actual,
    isRetiredSearchIndex: (index: string) =>
      index === 'metrics_images_v1' ? m.retired.metrics : actual.isRetiredSearchIndex(index),
  };
});

vi.mock('~/server/services/image.service', () => ({
  getImagesFromSearch: m.getImagesFromSearch,
  dropBlockedImageDeleteQueue: m.dropBlockedImageDeleteQueue,
  queueImageSearchIndexUpdate: m.queueImageSearchIndexUpdate,
}));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity: m.trackModActivity }));
vi.mock('~/server/services/feature-flags.service', () => ({ getFeatureFlags: () => ({}) }));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbReadLong: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-helpers', () => ({ dataProcessor: m.dataProcessor }));
vi.mock('~/server/meilisearch/client', () => ({
  metricsSearchClient: { index: m.metricsIndex },
  searchClient: { index: () => ({ search: m.imagesSearch }) },
  updateDocs: m.updateDocs,
}));

import unblockImages from '~/pages/api/mod/unblock-images';
import markPoiImagesSearch from '~/pages/api/mod/mark-poi-images-search';
import imageMetricsUpdate from '~/pages/api/mod/search/image-metrics-update';
import backfillStuckPublishedImages from '~/pages/api/admin/temp/backfill-stuck-published-images';
import { dbMock } from '~/__tests__/mocks/db.mock';

// `~/server/db/client` and `~/server/logging/client` are the global canonical mocks (setup.ts).
const updateManyAndReturn = dbMock.dbWrite.image.updateManyAndReturn;
const updateMany = dbMock.dbWrite.image.updateMany;

type Handler = (req: NextApiRequest, res: NextApiResponse, user?: unknown) => unknown;

const call = async (handler: unknown, query: Record<string, string> = {}) => {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    on: vi.fn(),
  };
  await (handler as Handler)(
    { method: 'GET', query, headers: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
    { id: 1, isModerator: true }
  );
  return {
    status: res.status.mock.calls[0]?.[0] as number | undefined,
    body: res.json.mock.calls[0]?.[0] as Record<string, unknown> | undefined,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  m.retired.metrics = true;
  updateManyAndReturn.mockResolvedValue([]);
  updateMany.mockResolvedValue({ count: 0 });
});

describe('/api/mod/unblock-images', () => {
  it('refuses with 410 while the feeds index is retired, before reading it or writing the DB', async () => {
    const { status, body } = await call(unblockImages);
    expect(status).toBe(410);
    expect(String(body?.message)).toContain('metrics_images_v1');
    expect(m.getImagesFromSearch).not.toHaveBeenCalled();
    expect(updateManyAndReturn).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('un-retired, clears only rows the database still has blocked, and acts on those alone', async () => {
    m.retired.metrics = false;
    // The index says 11 and 12 are moderated-blocked; the database has since re-blocked 12.
    m.getImagesFromSearch
      .mockResolvedValueOnce({
        data: [
          { id: 11, needsReview: null, nsfwLevel: 1 },
          { id: 12, needsReview: null, nsfwLevel: 2 },
        ],
      })
      .mockResolvedValueOnce({ data: [] });
    updateManyAndReturn.mockResolvedValue([{ id: 11 }]);

    const { status, body } = await call(unblockImages);

    expect(status).toBe(200);
    expect(updateMany).not.toHaveBeenCalled();
    expect(updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        id: { in: [11, 12] },
        blockedFor: { in: ['moderated', 'Moderated'] },
        needsReview: null,
        nsfwLevel: { notIn: [0, 32] },
      },
      data: { blockedFor: null },
      select: { id: true },
    });
    expect(m.dropBlockedImageDeleteQueue).toHaveBeenCalledWith([11]);
    expect(m.queueImageSearchIndexUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [11] })
    );
    expect(body).toMatchObject({ updated: 1 });
  });
});

describe('/api/mod/mark-poi-images-search', () => {
  it('writes poi to the database even when an index write would throw, and skips retired indexes', async () => {
    m.imagesSearch.mockResolvedValue({ hits: [{ id: 7, prompt: 'a photo of jane doe' }] });
    m.updateDocs.mockRejectedValue(new Error('meilisearch is shut down'));

    const { status } = await call(markPoiImagesSearch, { words: 'jane doe' });

    expect(status).toBe(200);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: { in: [7] } }, data: { poi: true } });
    expect(m.updateDocs).not.toHaveBeenCalled();
  });

  it('un-retired, the database write still lands before an index write that throws', async () => {
    m.retired.metrics = false;
    m.imagesSearch.mockResolvedValue({ hits: [{ id: 7, prompt: 'a photo of jane doe' }] });
    m.updateDocs.mockRejectedValue(new Error('meilisearch is shut down'));

    await call(markPoiImagesSearch, { words: 'jane doe' });

    expect(updateMany).toHaveBeenCalledWith({ where: { id: { in: [7] } }, data: { poi: true } });
    expect(m.updateDocs).toHaveBeenCalledWith(
      expect.objectContaining({ indexName: 'metrics_images_v1' })
    );
  });
});

describe('/api/mod/search/image-metrics-update', () => {
  it('refuses with 410 while the feeds index is retired', async () => {
    const { status } = await call(imageMetricsUpdate, { update: 'addFields' });
    expect(status).toBe(410);
    expect(m.dataProcessor).not.toHaveBeenCalled();
    expect(m.updateDocs).not.toHaveBeenCalled();
  });
});

describe('/api/admin/temp/backfill-stuck-published-images', () => {
  it('refuses with 410 while the feeds index is retired, without opening the index', async () => {
    const { status } = await call(backfillStuckPublishedImages);
    expect(status).toBe(410);
    expect(m.metricsIndex).not.toHaveBeenCalled();
    expect(m.dataProcessor).not.toHaveBeenCalled();
  });
});
