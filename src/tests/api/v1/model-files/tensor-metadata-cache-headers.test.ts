import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for CU 868khnkuc: the 1-year `immutable` Cache-Control was set BEFORE the
 * upstream byte-range fetch, so a transient 422 inherited it and Cloudflare froze the error at
 * the edge for a year (207K byte-range errors / 14d, each poisoning that file's Tensors panel).
 * Only 200 responses may carry the immutable header; every error path must stay no-store.
 */

const IMMUTABLE = 'public, max-age=31536000, s-maxage=31536000, immutable';
const NO_STORE = 'private, no-store';

const { mockFindUnique, mockGetFileForModelVersion, mockGetFullTensorAnalysisCached } = vi.hoisted(
  () => ({
    mockFindUnique: vi.fn(),
    mockGetFileForModelVersion: vi.fn(),
    mockGetFullTensorAnalysisCached: vi.fn(),
  })
);

vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint: (handler: any) => (req: any, res: any) => handler(req, res, undefined),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { modelFile: { findUnique: (...args: any[]) => mockFindUnique(...args) } },
}));

vi.mock('~/server/services/file.service', () => ({
  getFileForModelVersion: (...args: any[]) => mockGetFileForModelVersion(...args),
}));

vi.mock('~/server/services/tensor-metadata.service', () => ({
  getFullTensorAnalysisCached: (...args: any[]) => mockGetFullTensorAnalysisCached(...args),
}));

// Both caches are pass-through here: this test pins response headers, not cache behaviour
// (that contract lives in tensor-metadata-cache-split.test.ts).
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: (_key: string, fetcher: () => Promise<unknown>) => fetcher(),
}));

vi.mock('~/server/redis/client', () => ({
  REDIS_KEYS: {
    CACHES: {
      TENSOR_METADATA: 'packed:caches:tensor-metadata',
      TENSOR_METADATA_SUMMARY: 'packed:caches:tensor-metadata-summary',
    },
  },
}));

vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn().mockResolvedValue(undefined) }));

const analysis = {
  format: 'SafeTensor',
  tensorCount: 1,
  totalTensorBytes: 8,
  dtypes: [],
  largestTensor: null,
  vramEstimate: null,
  tensors: [{ name: 'weight', shape: [2, 2], dtype: 'F16', sizeBytes: 8 }],
};

let handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void;

beforeAll(async () => {
  const mod = await import('~/pages/api/v1/model-files/[id]/tensor-metadata');
  handler = mod.default as any;
}, 120000);

function fakeRes() {
  const headers: Record<string, string> = {};
  const res: any = {
    setHeader(key: string, value: string) {
      headers[key.toLowerCase()] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    _getHeader: (key: string) => headers[key.toLowerCase()],
  };
  return res as NextApiResponse & {
    statusCode?: number;
    body?: any;
    _getHeader: (key: string) => string | undefined;
  };
}

async function invoke(query: Record<string, unknown>) {
  const res = fakeRes();
  await handler({ method: 'GET', query } as unknown as NextApiRequest, res);
  return res;
}

describe('/api/v1/model-files/[id]/tensor-metadata cache headers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUnique.mockResolvedValue({
      id: 3057178,
      modelVersionId: 3176604,
      name: 'moody-cutie-mix.safetensors',
      type: 'Model',
      sizeKB: 24_000_000,
      metadata: { format: 'SafeTensor' },
      modelVersion: { model: { type: 'Checkpoint' } },
    });
    mockGetFileForModelVersion.mockResolvedValue({
      status: 'success',
      url: 'https://delivery.example/file.safetensors',
    });
    mockGetFullTensorAnalysisCached.mockResolvedValue(analysis);
  });

  it('caches a successful full analysis for a year', async () => {
    const res = await invoke({ id: '3057178' });

    expect(res.statusCode).toBe(200);
    expect(res._getHeader('Cache-Control')).toBe(IMMUTABLE);
  });

  it('caches a successful summary for a year', async () => {
    const res = await invoke({ id: '3057178', summaryOnly: 'true' });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty('tensors');
    expect(res._getHeader('Cache-Control')).toBe(IMMUTABLE);
  });

  it('does NOT cache the 422 when the upstream byte-range fetch fails', async () => {
    mockGetFullTensorAnalysisCached.mockRejectedValue(
      new Error('Model host does not support byte-range requests')
    );

    const res = await invoke({ id: '3057178' });

    expect(res.statusCode).toBe(422);
    expect(res._getHeader('Cache-Control')).toBe(NO_STORE);
  });

  it('does NOT cache the 422 on the summaryOnly path either', async () => {
    mockGetFullTensorAnalysisCached.mockRejectedValue(
      new Error('Model host does not support byte-range requests')
    );

    const res = await invoke({ id: '3057178', summaryOnly: 'true' });

    expect(res.statusCode).toBe(422);
    expect(res._getHeader('Cache-Control')).toBe(NO_STORE);
  });

  it('ignores the cache-busting version param the client sends', async () => {
    const res = await invoke({ id: '3057178', summaryOnly: 'true', v: '2' });

    expect(res.statusCode).toBe(200);
    expect(res._getHeader('Cache-Control')).toBe(IMMUTABLE);
  });

  it('does not cache the access-denied response', async () => {
    mockGetFileForModelVersion.mockResolvedValue({ status: 'no-access' });

    const res = await invoke({ id: '3057178' });

    expect(res.statusCode).toBe(403);
    expect(res._getHeader('Cache-Control')).toBe(NO_STORE);
  });
});
