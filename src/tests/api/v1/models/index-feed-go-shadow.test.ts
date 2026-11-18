import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * The feed-go shadow wiring of `GET /api/v1/models`: which requests are sampled, and that every
 * sampled request is finished with the status it answered (a non-200 is then counted
 * `skipped_status` by the sampler), not only the 200 path.
 */

const { mockRunModelSearch, mockBegin, mockCapture, mockFinish, session } = vi.hoisted(() => ({
  mockRunModelSearch: vi.fn(),
  mockBegin: vi.fn(),
  mockCapture: vi.fn(),
  mockFinish: vi.fn(),
  session: { user: undefined as { id: number } | undefined },
}));

vi.mock('~/server/trpc/feed-go-shadow', () => ({
  beginFeedGoShadowV1Models: mockBegin,
  captureFeedGoShadowRest: mockCapture,
  finishFeedGoShadow: mockFinish,
}));

vi.mock('~/server/services/model-search.service', () => ({
  runModelSearch: mockRunModelSearch,
  resolveModelSearchIds: vi.fn().mockResolvedValue({ searchIds: [], nextCursor: undefined }),
  ModelSearchMeiliTimeoutError: class extends Error {},
}));

vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => 'US',
  isRegionRestricted: () => false,
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint: (handler: any) => (req: any, res: any) => handler(req, res, session.user),
  handleEndpointError: (res: any, e: any) => res.status(500).json({ error: String(e) }),
}));

vi.mock('~/server/utils/pagination-helpers', () => ({
  getNextPage: () => ({ baseUrl: { origin: 'https://site.example.test' }, nextPage: undefined }),
  getPagination: () => ({ skip: 0 }),
}));

vi.mock('~/server/services/user.service', () => ({
  getUserBookmarkCollections: vi.fn().mockResolvedValue([]),
}));

function fakeRes() {
  const res: any = {
    headers: {},
    setHeader(k: string, v: unknown) {
      this.headers[k] = v;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res as NextApiResponse & { statusCode?: number; body?: any };
}

let handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void;

beforeAll(async () => {
  const mod = await import('~/pages/api/v1/models/index');
  handler = mod.default as any;
}, 120000);

async function invoke(query: Record<string, unknown>) {
  const req = {
    method: 'GET',
    query,
    headers: { host: 'site.example.test' },
    url: '/api/v1/models',
  } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

const SAMPLE = { endpoint: 'v1-models' };

describe('/api/v1/models — feed-go shadow sampling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.user = undefined;
    mockBegin.mockReturnValue(SAMPLE);
    mockRunModelSearch.mockResolvedValue({ items: [{ id: 1 }], nextCursor: undefined });
  });

  it('a sampled 200: captures the body it writes and finishes with 200', async () => {
    const res = await invoke({ limit: '1' });
    expect(res.statusCode).toBe(200);
    expect(mockBegin).toHaveBeenCalledWith(expect.anything(), 'list');
    expect(mockCapture).toHaveBeenCalledWith(SAMPLE, res.body);
    expect(mockFinish).toHaveBeenCalledTimes(1);
    expect(mockFinish).toHaveBeenCalledWith(SAMPLE, 200, res);
  });

  it('a sampled request that errors is finished with its status (skipped_status), not dropped', async () => {
    mockRunModelSearch.mockRejectedValue(new Error('boom'));
    const res = await invoke({ limit: '1' });
    expect(res.statusCode).toBe(500);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockFinish).toHaveBeenCalledTimes(1);
    expect(mockFinish).toHaveBeenCalledWith(SAMPLE, 500, res);
  });

  it('a text query is never sampled (feed-go falls back on every one: v1-models-query)', async () => {
    const res = await invoke({ query: 'cat', limit: '1' });
    expect(res.statusCode).toBe(200);
    expect(mockBegin).not.toHaveBeenCalled();
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it('a signed-in caller is never sampled (feed-go falls back on every one: v1-models-session)', async () => {
    session.user = { id: 7 };
    const res = await invoke({ limit: '1' });
    expect(res.statusCode).toBe(200);
    expect(mockBegin).not.toHaveBeenCalled();
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it('an unsampled request touches nothing', async () => {
    mockBegin.mockReturnValue(undefined);
    await invoke({ limit: '1' });
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockFinish).not.toHaveBeenCalled();
  });
});
