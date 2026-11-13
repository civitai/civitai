import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as SearchIndex from '~/server/search-index';

/**
 * POST /api/internal/search-index-update: the moderator app syncs every image it moderates through
 * it (apps/moderator/src/lib/server/search-index.ts). When images_v6 was deleted, `image` left the
 * map with it and every one of those calls answered 400, leaving the metrics index unsynced.
 */

const { metricsQueue } = vi.hoisted(() => ({ metricsQueue: vi.fn() }));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  imagesMetricsSearchIndex: { queueUpdate: metricsQueue },
}));

const handler = (await import('~/pages/api/internal/search-index-update')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<void>;

function call(body: unknown) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return handler(
    { method: 'POST', body } as NextApiRequest,
    res as unknown as NextApiResponse
  ).then(() => res);
}

describe('search-index-update', () => {
  beforeEach(() => {
    metricsQueue.mockReset();
  });

  it("syncs a moderated image's metrics index", async () => {
    const res = await call({ entityType: 'image', entityId: 42, action: 'delete' });
    expect(res.statusCode).toBe(200);
    expect(metricsQueue).toHaveBeenCalledTimes(1);
    expect(metricsQueue.mock.calls[0][0]).toEqual([{ id: 42, action: 'Delete' }]);
  });

  it('still refuses an entity type it has no index for', async () => {
    const res = await call({ entityType: 'nope', entityId: 42 });
    expect(res.statusCode).toBe(400);
    expect(metricsQueue).not.toHaveBeenCalled();
  });
});
