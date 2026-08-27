import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Regression coverage for POST /api/v1/model-versions/by-hash — the batch
 * lookup must build its `downloadUrl`s from the REQUEST's host.
 *
 * The handler built its base URL from `req.headers.posthost`, which is not an
 * HTTP header and is set by nothing. `IncomingHttpHeaders` carries an index
 * signature (`NodeJS.Dict<string | string[]>`), so the misspelling is a legal
 * property access and typechecks; at runtime it is `undefined`, and
 * `new URL('https://undefined')` PARSES — origin `https://undefined` — rather
 * than throwing. Every `downloadUrl` in the response therefore pointed at
 * `https://undefined/...` in production, silently.
 *
 * The sibling `[id].ts` (whose `prepareModelVersionResponse` this endpoint
 * calls) and `by-hash/[hash].ts` (which reaches the same shaper through
 * `resModelVersionDetails`) both derive the base URL from `req.headers.host`
 * and fall back to localhost when it is absent. This suite pins that this
 * endpoint agrees with them.
 *
 * 🔴 `isProd` is mocked TRUE deliberately. It is `NODE_ENV === 'production'`,
 * evaluated at module load, so under Vitest it is FALSE and the handler takes
 * its `'http://localhost:3000'` dev branch — the production expression that
 * carries the defect never executes. Without this mock every assertion below
 * passes on the BROKEN code.
 */
vi.mock('~/env/other', () => ({
  isProd: true,
  isDev: false,
  isTest: false,
  isPreview: false,
}));

/**
 * `~/env/client-schema` reads the SAME `isProd` and tightens itself when it is
 * true (`NEXT_PUBLIC_CIVITAI_LINK` goes from optional to required). Vitest does
 * not load `.env` into `process.env`, so without this the mock above turns a
 * client-env validation throw into a COLLECTION failure — which reports as
 * "no tests" rather than as a red assertion. Hoisted so it lands before the
 * module graph is imported.
 */
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CIVITAI_LINK ??= 'https://link.example.test';
});

// Unwrap PublicEndpoint so the raw handler is invoked directly (no CORS/cache side effects).
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: unknown) => handler,
  MixedAuthEndpoint: (handler: unknown) => handler,
}));

// I/O behind the real `prepareModelVersionResponse`. The URL construction
// itself (`createSerializedFileDownloadUrl`, `getPrimaryFile`) stays REAL — the
// emitted string is the contract under test.
vi.mock('~/server/services/model.service', () => ({ getVaeFiles: vi.fn(async () => []) }));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(async () => []),
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(async () => ({})),
  getPublicPaidAccessForModelVersions: vi.fn(async () => ({})),
  toPublicPaidAccessDto: () => null,
  bustModelSaleCache: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  hasValidCreatorMembershipCached: async () => false,
}));
vi.mock('~/server/services/file.service', () => ({
  getDownloadFilename: ({ file }: any) => `${file.id}.safetensors`,
}));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => 'US',
  isRegionRestricted: () => false,
}));

import handler from '~/pages/api/v1/model-versions/by-hash/index';

const HASH = 'A'.repeat(64);

/**
 * Two Public files on one version, pairwise distinct on every axis the
 * serializer could key off, so an assertion cannot pass by coincidence.
 */
const FILES = [
  {
    id: 21,
    type: 'Model',
    visibility: 'Public',
    sizeKB: 1111,
    modelVersionId: 4242,
    url: 's3://a',
    name: 'a.safetensors',
    hashes: [{ type: 'SHA256', hash: 'aaaa1111' }],
    metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
  },
  {
    id: 22,
    type: 'Model',
    visibility: 'Public',
    sizeKB: 2222,
    modelVersionId: 4242,
    url: 's3://b',
    name: 'b.ckpt',
    hashes: [{ type: 'SHA256', hash: 'bbbb2222' }],
    metadata: { format: 'PickleTensor', size: 'full', fp: 'fp32' },
  },
];

function modelVersion() {
  return {
    id: 4242,
    modelId: 77,
    name: 'v1',
    baseModel: 'SD 1.5',
    status: 'Published',
    nsfwLevel: 1,
    licensingFee: null,
    files: FILES.map((f) => ({ ...f })),
    metrics: [{ downloadCount: 5, thumbsUpCount: 2 }],
    model: { name: 'Model 77', type: 'Checkpoint', nsfw: false, poi: false, mode: null },
  } as any;
}

async function invokeByHash(headers: Record<string, unknown>) {
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
  await (handler as unknown as (req: any, res: any) => Promise<void>)(
    { method: 'POST', body: [HASH], headers },
    res
  );
  return res;
}

/** Every absolute URL the response advertises, across all versions and files. */
function downloadUrls(res: any): string[] {
  const versions = res.body as any[];
  return versions.flatMap((v) => [
    v.downloadUrl,
    ...(v.files as any[]).map((f: any) => f.downloadUrl),
  ]);
}

describe('POST /api/v1/model-versions/by-hash — downloadUrl host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.modelFile.findMany.mockResolvedValue([{ modelVersion: modelVersion() }]);
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(null);
  });

  it('builds every downloadUrl from the request host', async () => {
    const res = await invokeByHash({ host: 'models.example.test' });
    expect(res.statusCode).toBe(200);

    const urls = downloadUrls(res);
    // Positive control: the assertions below are claims about a non-empty set.
    expect(urls).toHaveLength(3);

    for (const url of urls) {
      expect(new URL(url).origin, `downloadUrl ${url}`).toBe('https://models.example.test');
    }
  });

  /**
   * The control that separates "reads the request host" from "happens to emit
   * the constant the previous test names". A hardcoded origin — including the
   * broken `https://undefined` — cannot satisfy both hosts.
   */
  it('tracks the host per request rather than emitting a fixed origin', async () => {
    const first = downloadUrls(await invokeByHash({ host: 'first.example.test' }));
    dbMock.dbRead.modelFile.findMany.mockResolvedValue([{ modelVersion: modelVersion() }]);
    const second = downloadUrls(await invokeByHash({ host: 'second.example.test' }));

    expect(new Set(first.map((u) => new URL(u).origin))).toEqual(
      new Set(['https://first.example.test'])
    );
    expect(new Set(second.map((u) => new URL(u).origin))).toEqual(
      new Set(['https://second.example.test'])
    );
  });

  it('never emits the literal host "undefined"', async () => {
    const urls = downloadUrls(await invokeByHash({ host: 'models.example.test' }));
    expect(urls).not.toHaveLength(0);
    for (const url of urls) expect(new URL(url).hostname).not.toBe('undefined');
  });

  /**
   * The second half of the defect: the broken expression had no guard, so a
   * request arriving without a Host header produced `https://undefined` too.
   * The siblings fall back to localhost; this pins that behaviour.
   */
  it('falls back to localhost when the request carries no host header', async () => {
    const urls = downloadUrls(await invokeByHash({}));
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(new URL(url).origin, `downloadUrl ${url}`).toBe('http://localhost:3000');
    }
  });
});
