import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// adjust-tag-level UPDATEs a tag's nsfwLevel/type — a dimension the cached `getTags`
// listings filter on — so it must bust the getTags listing cache alongside the
// existing per-id / per-name tag caches. This drives the handler in isolation and
// asserts the bust fires exactly when rows were actually updated.
const { pgQuery, batchProcessor, tagBust, tagByNameBust, bustGetTagsCache } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  batchProcessor: vi.fn().mockResolvedValue(undefined),
  tagBust: vi.fn().mockResolvedValue(undefined),
  tagByNameBust: vi.fn().mockResolvedValue(undefined),
  bustGetTagsCache: vi.fn().mockResolvedValue(undefined),
}));

// WebhookEndpoint is a passthrough wrapper in tests.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: any) => handler,
}));
vi.mock('~/server/db/pgDb', () => ({ pgDbWrite: { query: pgQuery } }));
vi.mock('~/server/db/db-helpers', () => ({ batchProcessor }));
vi.mock('~/server/redis/caches', () => ({
  tagCache: { bust: tagBust },
  tagCacheByName: { bust: tagByNameBust },
}));
// Stub tag.service so importing the handler doesn't pull the full server graph.
vi.mock('~/server/services/tag.service', () => ({ bustGetTagsCache }));

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
