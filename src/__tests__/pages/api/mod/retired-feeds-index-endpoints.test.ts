import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The mod endpoint that used to select from the feeds index (`metrics_images_v1`). Retired, the
// index is gone with its Meilisearch instance, so the endpoint must work from Postgres alone. The
// endpoints whose whole job was reading or backfilling that index were deleted with it.

const m = vi.hoisted(() => ({
  dropBlockedImageDeleteQueue: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
  trackModActivity: vi.fn(),
  updateDocs: vi.fn(),
  imagesSearch: vi.fn(),
  dataProcessor: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  ModEndpoint: (handler: unknown) => handler,
  WebhookEndpoint: (handler: unknown) => handler,
}));

vi.mock('~/server/services/image.service', () => ({
  dropBlockedImageDeleteQueue: m.dropBlockedImageDeleteQueue,
  queueImageSearchIndexUpdate: m.queueImageSearchIndexUpdate,
}));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity: m.trackModActivity }));
vi.mock('~/server/services/feature-flags.service', () => ({ getFeatureFlags: () => ({}) }));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbReadLong: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-helpers', () => ({ dataProcessor: m.dataProcessor }));
vi.mock('~/server/meilisearch/client', () => ({
  searchClient: { index: () => ({ search: m.imagesSearch }) },
  updateDocs: m.updateDocs,
}));

import unblockImages from '~/server/api-routes/mod/unblock-images';
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
  updateManyAndReturn.mockResolvedValue([]);
  updateMany.mockResolvedValue({ count: 0 });
});

describe('/api/mod/unblock-images', () => {
  it('scans Postgres while the feeds index is retired, and clears only rows the primary still has blocked', async () => {
    // The replica scan finds 11 and 12; the primary has since re-blocked 12.
    dbMock.dbRead.$queryRaw
      .mockResolvedValueOnce([{ maxId: 12 }])
      .mockResolvedValueOnce([{ id: 11 }, { id: 12 }]);
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
