import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * Regression test for CU 868khnkuc: the 1-year `immutable` Cache-Control was set BEFORE the
 * upstream byte-range fetch, so a transient 422 inherited it and Cloudflare froze the error at
 * the edge for a year (207K byte-range errors / 14d, each poisoning that file's Tensors panel).
 * Only 200 responses may carry the immutable header; every error path must stay no-store.
 */

const IMMUTABLE = 'public, max-age=31536000, s-maxage=31536000, immutable';
const NO_STORE = 'private, no-store';

const { mockGetFileForModelVersion, mockGetFullTensorAnalysisCached, mockCorrect } = vi.hoisted(
  () => ({
    mockGetFileForModelVersion: vi.fn(),
    mockGetFullTensorAnalysisCached: vi.fn(),
    mockCorrect: vi.fn(),
  })
);
const mockFindUnique = dbMock.dbRead.modelFile.findUnique;

vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint: (handler: any) => (req: any, res: any) => handler(req, res, undefined),
}));

vi.mock('~/server/services/file.service', () => ({
  getFileForModelVersion: (...args: any[]) => mockGetFileForModelVersion(...args),
}));

vi.mock('~/server/services/tensor-metadata.service', () => ({
  getFullTensorAnalysisCached: (...args: any[]) => mockGetFullTensorAnalysisCached(...args),
}));

// Stubbed rather than run: the real module reaches `model-file.service`, which builds a
// `createCachedObject` at module scope and so needs a cache-helpers mock wider than this
// file's deliberate pass-through. What the correction DECIDES is pinned in
// model-file-header-correction.service.test.ts; what this file pins is that the endpoint
// calls it at all, and with the file's own values.
vi.mock('~/server/services/model-file-header-correction.service', () => ({
  correctModelFileFromTensorHeader: (...args: any[]) => mockCorrect(...args),
}));

// Both caches are pass-through here: this test pins response headers, not cache behaviour
// (that contract lives in tensor-metadata-cache-split.test.ts).
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: (_key: string, fetcher: () => Promise<unknown>) => fetcher(),
}));

const analysis = {
  format: 'SafeTensor',
  tensorCount: 1,
  totalTensorBytes: 8,
  dtypeCounts: [{ dtype: 'F16', count: 1, bytes: 8 }],
  detectedModelType: null,
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
      url: 'https://storage.example/moody-cutie-mix.safetensors',
      metadata: { format: 'SafeTensor', fp: 'fp32' },
      modelVersion: { model: { type: 'Checkpoint' } },
    });
    mockCorrect.mockResolvedValue({ corrections: {}, applied: false });
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

  /**
   * 🔴 The endpoint is the correction's ONLY production caller, and three plausible
   * one-line edits kill it silently: dropping either `return void correct(...)`, dropping
   * `url: true` from the select (the url guard then matches nothing and every write is a
   * no-op), or swapping `currentFileType` and `modelType`. None of those changes a
   * response, a status or a log, so without this test the feature can go inert unnoticed.
   */
  it.each([
    ['full', {}],
    ['summary', { summaryOnly: 'true' }],
  ])('hands the %s path the file’s own values to correct', async (_label, extra) => {
    const res = await invoke({ id: '3057178', ...extra });

    expect(res.statusCode).toBe(200);
    expect(mockCorrect).toHaveBeenCalledTimes(1);

    const arg = mockCorrect.mock.calls[0][0];
    expect(arg.fileId).toBe(3057178);
    expect(arg.modelVersionId).toBe(3176604);
    // Not the delivery url getFileForModelVersion resolved — the stored one the guard needs.
    expect(arg.fileUrl).toBe('https://storage.example/moody-cutie-mix.safetensors');
    // Asserted as distinct literals: a single objectContaining would pass with these two swapped.
    expect(arg.currentFileType).toBe('Model');
    expect(arg.modelType).toBe('Checkpoint');
    expect(arg.currentFp).toBe('fp32');
    expect(arg.format).toBe('SafeTensor');
  });

  /**
   * 🔴 Asserted on the SELECT, not on the value, and that is the whole point. `findUnique`
   * is mocked, so the mock returns the whole fixture whatever the select asks for — drop
   * `url: true` from the handler and every behavioural assertion above still passes while
   * `fileUrl` is `undefined` in production, the `AND "url" =` guard matches nothing, and
   * the feature is inert forever with no error, no log and no changed response. Measured:
   * with this test absent, deleting that line left all 10 tests green.
   */
  it('selects the columns the correction needs', async () => {
    await invoke({ id: '3057178' });

    const { select } = mockFindUnique.mock.calls[0][0];
    expect(select).toMatchObject({ url: true, type: true, metadata: true });
    expect(select.modelVersion).toMatchObject({ select: { model: { select: { type: true } } } });
  });

  it.each([
    ['the 422', () => mockGetFullTensorAnalysisCached.mockRejectedValue(new Error('boom'))],
    [
      'an access denial',
      () => mockGetFileForModelVersion.mockResolvedValue({ status: 'no-access' }),
    ],
  ])('does not correct on %s', async (_label, arrange) => {
    arrange();

    await invoke({ id: '3057178' });

    expect(mockCorrect).not.toHaveBeenCalled();
  });

  it('does not cache the access-denied response', async () => {
    mockGetFileForModelVersion.mockResolvedValue({ status: 'no-access' });

    const res = await invoke({ id: '3057178' });

    expect(res.statusCode).toBe(403);
    expect(res._getHeader('Cache-Control')).toBe(NO_STORE);
  });
});
