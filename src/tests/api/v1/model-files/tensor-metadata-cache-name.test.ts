import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Seam coverage for the tensor-metadata endpoint's CALL SITE of `fetchThroughCache`.
 *
 * `cacheName` is observational — it only decides the `cache_name` label on the packed codec
 * duration histogram — so deleting it here changes no response, no cached value and no status
 * code. Every other test of this endpoint (cache headers, cache split) therefore stays green with
 * the option gone, while the histogram quietly collapses this cache's samples into the redis
 * client's 'unknown' fallback alongside every other unnamed compressed caller.
 *
 * A test that re-declared the options itself would only pin its own copy, so this drives the REAL
 * handler module and reads the options the endpoint actually passes.
 *
 * The label literals are written out rather than imported from REDIS_KEYS on purpose: the claim is
 * about what the metric's label will BE, and deriving the expectation from the same constant the
 * implementation reads would make a rename invisible on both sides at once.
 */

const FULL_CACHE_NAME = 'packed:caches:tensor-metadata';
const SUMMARY_CACHE_PREFIX = 'packed:caches:tensor-metadata-summary';
const FILE_ID = 3057178;

const analysis = {
  format: 'SafeTensor',
  tensorCount: 1,
  totalTensorBytes: 8,
  dtypeCounts: [],
  largestTensor: null,
  vramEstimate: null,
  tensors: [{ name: 'weight', shape: [2, 2], dtype: 'F16', sizeBytes: 8 }],
};

const {
  mockGetFileForModelVersion,
  mockGetFullTensorAnalysisCached,
  mockParseModelTensorMetadata,
  fetchThroughCacheCalls,
} = vi.hoisted(() => ({
  mockGetFileForModelVersion: vi.fn(),
  mockGetFullTensorAnalysisCached: vi.fn(),
  mockParseModelTensorMetadata: vi.fn(),
  fetchThroughCacheCalls: [] as { key: string; options: Record<string, unknown> | undefined }[],
}));

const mockFindUnique = dbMock.dbRead.modelFile.findUnique;

vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint: (handler: any) => (req: any, res: any) => handler(req, res, undefined),
}));

vi.mock('~/server/services/file.service', () => ({
  getFileForModelVersion: (...args: any[]) => mockGetFileForModelVersion(...args),
}));

// The real parser issues an upstream byte-range HTTP fetch; this file is about cache options.
vi.mock('~/utils/model-tensor-metadata', () => ({
  inferTensorMetadataFormat: () => 'SafeTensor',
  supportsTensorVramEstimate: () => false,
  parseModelTensorMetadata: (...args: any[]) => mockParseModelTensorMetadata(...args),
}));

// Pass-through in beforeEach, so the FULL `fetchThroughCache` the endpoint composes INSIDE it
// actually runs. (The sibling header test stubs this with a resolved value, which short-circuits
// the composition — which is exactly why that file cannot see this defect.)
vi.mock('~/server/services/tensor-metadata.service', () => ({
  getFullTensorAnalysisCached: (...args: any[]) => mockGetFullTensorAnalysisCached(...args),
}));

// Records (key, options) and then runs the fetcher, so both caches resolve normally.
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: (
    key: string,
    fetcher: () => Promise<unknown>,
    options?: Record<string, unknown>
  ) => {
    fetchThroughCacheCalls.push({ key, options });
    return fetcher();
  },
}));

let handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void;

beforeAll(async () => {
  const mod = await import('~/pages/api/v1/model-files/[id]/tensor-metadata');
  handler = mod.default as any;
}, 120000);

function fakeRes() {
  const res: any = {
    setHeader() {
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
  };
  return res as NextApiResponse & { statusCode?: number; body?: any };
}

async function invoke(query: Record<string, unknown>) {
  const res = fakeRes();
  await handler({ method: 'GET', query } as unknown as NextApiRequest, res);
  return res;
}

const fullCall = () =>
  fetchThroughCacheCalls.find((c) => c.key === `${FULL_CACHE_NAME}:${FILE_ID}`);
const summaryCall = () =>
  fetchThroughCacheCalls.find((c) => c.key === `${SUMMARY_CACHE_PREFIX}:${FILE_ID}`);

describe('/api/v1/model-files/[id]/tensor-metadata — codec cache_name at the call site', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchThroughCacheCalls.length = 0;
    mockFindUnique.mockResolvedValue({
      id: FILE_ID,
      modelVersionId: 3176604,
      name: 'a-model.safetensors',
      type: 'Model',
      sizeKB: 24_000_000,
      metadata: { format: 'SafeTensor' },
      modelVersion: { model: { type: 'Checkpoint' } },
    });
    mockGetFileForModelVersion.mockResolvedValue({
      status: 'success',
      url: 'https://delivery.example/file.safetensors',
    });
    mockParseModelTensorMetadata.mockResolvedValue(analysis);
    // Pass-through: invoke the factory the endpoint hands it, so its inner fetchThroughCache runs.
    mockGetFullTensorAnalysisCached.mockImplementation(
      async (_id: number, factory: () => Promise<unknown>) => factory()
    );
  });

  it('names the FULL compressed cache so its codec samples are attributable', async () => {
    const res = await invoke({ id: String(FILE_ID) });
    expect(res.statusCode).toBe(200);

    // Positive control: the full cache was reached at all, so the assertions below are reachable.
    expect(fullCall(), 'the endpoint fetched the FULL tensor-metadata cache').toBeDefined();

    expect(
      fullCall()!.options?.compress,
      'the FULL cache still opts into compression (nothing records codec time without it)'
    ).toBe(true);
    expect(
      fullCall()!.options?.cacheName,
      'the FULL cache is named, so its codec samples do not fall into the client "unknown" bucket'
    ).toBe(FULL_CACHE_NAME);
  });

  it('labels with the cache PREFIX, never the per-id key it reads', async () => {
    await invoke({ id: String(FILE_ID) });

    const call = fullCall()!;
    expect(call.key, 'the key really is the per-id one').toBe(`${FULL_CACHE_NAME}:${FILE_ID}`);
    expect(
      call.options?.cacheName,
      'cache_name must not be the per-id key — that is one histogram series per cached file'
    ).not.toBe(call.key);
  });

  it('the summary cache stays uncompressed and unnamed (no codec runs there)', async () => {
    const res = await invoke({ id: String(FILE_ID), summaryOnly: 'true' });
    expect(res.statusCode).toBe(200);

    expect(summaryCall(), 'the endpoint fetched the SUMMARY cache').toBeDefined();
    expect(summaryCall()!.options?.compress).toBeFalsy();
    expect(
      summaryCall()!.options?.cacheName,
      'an uncompressed cache records no codec samples, so a label there would name nothing'
    ).toBeUndefined();
  });

  it('reaches the FULL cache (still named) on a summary MISS', async () => {
    await invoke({ id: String(FILE_ID), summaryOnly: 'true' });

    expect(fullCall(), 'a summary miss falls through to the full fetch').toBeDefined();
    expect(fullCall()!.options?.cacheName).toBe(FULL_CACHE_NAME);
  });
});
