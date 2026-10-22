import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// adjust-tag-level UPDATEs a tag's nsfwLevel/type — a dimension the cached `getTags`
// listings filter on — so it must bust the getTags listing cache alongside the
// existing per-id / per-name tag caches. This drives the handler in isolation and
// asserts the bust fires exactly when rows were actually updated.
const {
  pgQuery,
  pgCancellableQuery,
  batchProcessor,
  tagBust,
  tagByNameBust,
  bustGetTagsCache,
  refreshProfilePicturesForImages,
} = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgCancellableQuery: vi.fn(),
  refreshProfilePicturesForImages: vi.fn(async (_ids: number[]) => undefined),
  batchProcessor: vi.fn().mockResolvedValue(undefined),
  tagBust: vi.fn().mockResolvedValue(undefined),
  tagByNameBust: vi.fn().mockResolvedValue(undefined),
  bustGetTagsCache: vi.fn().mockResolvedValue(undefined),
}));

// WebhookEndpoint is a passthrough wrapper in tests.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: any) => handler,
}));
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {},
  pgDbReadLong: {},
  pgDbWrite: { query: pgQuery, cancellableQuery: pgCancellableQuery },
}));
vi.mock('~/server/db/db-helpers', () => ({ batchProcessor }));
vi.mock('~/server/redis/caches', () => ({
  tagCache: { bust: tagBust },
  tagCacheByName: { bust: tagByNameBust },
}));
// Stub tag.service so importing the handler doesn't pull the full server graph.
vi.mock('~/server/services/tag.service', () => ({ bustGetTagsCache }));
// Same reason: the handler only needs the profile-picture refresh.
vi.mock('~/server/services/user.service', () => ({ refreshProfilePicturesForImages }));

import handler from '~/pages/api/mod/adjust-tag-level';

function createMocks(query: Record<string, string>) {
  const req = { method: 'GET', query } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse;
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('adjust-tag-level — getTags cache invalidation', () => {
  it('busts the getTags listing cache when tags were re-leveled', async () => {
    pgQuery.mockResolvedValue({ rows: [{ id: 11 }, { id: 12 }] });
    const { req, res } = createMocks({ tags: 'anime,nude', nsfwLevel: '1' });

    await handler(req, res);

    expect(bustGetTagsCache).toHaveBeenCalledTimes(1);
    // The existing per-name / per-id busts still fire too.
    expect(tagByNameBust).toHaveBeenCalled();
    expect(tagBust).toHaveBeenCalled();
  });

  it('does NOT bust when no rows changed (no-op update)', async () => {
    pgQuery.mockResolvedValue({ rows: [] });
    const { req, res } = createMocks({ tags: 'anime', nsfwLevel: '1' });

    await handler(req, res);

    expect(bustGetTagsCache).not.toHaveBeenCalled();
  });
});

// Avatars are gated on their cached rating, so a batch this re-rates must refresh the cached profile
// pictures of the users whose avatar is in it — after the batch's UPDATE, and without failing it.
describe('adjust-tag-level — profile pictures', () => {
  type Processor = (args: {
    batch: number[];
    batchNumber: number;
    batchCount: number;
  }) => Promise<void>;

  async function runOneBatch(batch: number[]) {
    pgQuery.mockResolvedValue({ rows: [{ id: 11 }] });
    const order: string[] = [];
    pgCancellableQuery.mockImplementation(async (sql: string) => ({
      result: async () => {
        if (sql.includes('UPDATE "Image"')) order.push('update');
        return [];
      },
    }));
    refreshProfilePicturesForImages.mockImplementation(async () => {
      order.push('refresh');
    });
    const { req, res } = createMocks({ tags: 'nude', nsfwLevel: '4' });
    await handler(req, res);

    const { processor } = batchProcessor.mock.calls[0][0] as { processor: Processor };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await processor({ batch, batchNumber: 1, batchCount: 1 });
    return order;
  }

  it('refreshes the batch after re-rating it', async () => {
    const order = await runOneBatch([501, 502]);

    expect(refreshProfilePicturesForImages).toHaveBeenCalledWith([501, 502]);
    expect(order).toEqual(['update', 'refresh']);
  });

  it('still completes the batch when the refresh fails', async () => {
    pgQuery.mockResolvedValue({ rows: [{ id: 11 }] });
    refreshProfilePicturesForImages.mockRejectedValueOnce(new Error('cache down'));
    pgCancellableQuery.mockImplementation(async () => ({ result: async () => [] }));
    const { req, res } = createMocks({ tags: 'nude', nsfwLevel: '4' });
    await handler(req, res);
    const { processor } = batchProcessor.mock.calls[0][0] as { processor: Processor };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      processor({ batch: [501], batchNumber: 1, batchCount: 1 })
    ).resolves.toBeUndefined();
  });
});
