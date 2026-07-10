import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { mockQuery, mockTagCache, mockTagCacheByName } = vi.hoisted(() => {
  return {
    mockQuery: vi.fn(),
    mockTagCache: { bust: vi.fn().mockResolvedValue(undefined) },
    mockTagCacheByName: { bust: vi.fn().mockResolvedValue(undefined) },
  };
});

vi.mock('~/server/db/pgDb', () => ({
  pgDbWrite: { query: mockQuery },
}));

vi.mock('~/server/redis/caches', () => ({
  tagCache: mockTagCache,
  tagCacheByName: mockTagCacheByName,
}));

vi.mock('~/server/db/db-helpers', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, batchProcessor: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('~/server/redis/client', () => ({
  redis: {},
  REDIS_KEYS: { CACHES: {} },
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: Function) => handler,
}));

vi.mock('~/env/server', () => ({
  env: new Proxy({}, {
    get(_target, prop: string) {
      if (prop === 'WEBHOOK_TOKEN') return 'mock-webhook-token';
      if (prop === 'IS_BUILD') return false;
      if (prop === 'LOGGING') return [];
      if (prop.endsWith('URL') || prop.endsWith('_URL') || prop.endsWith('ENDPOINT')) return 'http://localhost:3000';
      return 'mock-value';
    },
  }),
}));

import handler from '~/pages/api/mod/adjust-tag-level';

const runRequest = (query: Record<string, string>) => {
  const req = {
    method: 'POST',
    query: { token: 'mock-webhook-token', ...query },
    headers: { host: 'localhost:3000' },
    body: {},
  } as unknown as NextApiRequest;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse;

  return { promise: handler(req, res), res };
};

describe('adjust-tag-level - cache busting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('busts both tagCache (by id) and tagCacheByName (by name) when tags are updated', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 100 }, { id: 200 }] });

    const { promise } = runRequest({ tags: 'hate-speech,gore', nsfwLevel: '32' });
    await promise;

    expect(mockTagCacheByName.bust).toHaveBeenCalledWith('hate-speech');
    expect(mockTagCacheByName.bust).toHaveBeenCalledWith('gore');
    expect(mockTagCache.bust).toHaveBeenCalledWith(100);
    expect(mockTagCache.bust).toHaveBeenCalledWith(200);
    expect(mockTagCacheByName.bust).toHaveBeenCalledTimes(2);
    expect(mockTagCache.bust).toHaveBeenCalledTimes(2);
  });

  it('does not bust either cache when no rows were updated', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const { promise, res } = runRequest({ tags: 'already-correct-level', nsfwLevel: '32' });
    await promise;

    expect(mockTagCacheByName.bust).not.toHaveBeenCalled();
    expect(mockTagCache.bust).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ noUpdates: true })
    );
  });

  it('busts exactly the tags that were updated, not all requested tags', async () => {
    // 3 tags requested, only 2 found/updated in DB
    mockQuery.mockResolvedValue({ rows: [{ id: 42 }] });

    const { promise } = runRequest({ tags: 'tag-a,tag-b,tag-c', nsfwLevel: '16' });
    await promise;

    // tagCacheByName busts all requested names (we don't know which matched — DB doesn't tell us)
    expect(mockTagCacheByName.bust).toHaveBeenCalledTimes(3);
    // tagCache only busts the IDs the DB returned
    expect(mockTagCache.bust).toHaveBeenCalledTimes(1);
    expect(mockTagCache.bust).toHaveBeenCalledWith(42);
  });
});
