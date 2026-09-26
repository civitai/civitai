import { readFileSync } from 'fs';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { resolveModelFileName } from '~/utils/model-file-naming';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

void loggingMock;
void redisMock;

const { mockGetModelsWithVersions, mockGetVaeFiles, mockGetImages, mockGetPaidAccess } = vi.hoisted(
  () => ({
    mockGetModelsWithVersions: vi.fn(),
    mockGetVaeFiles: vi.fn(),
    mockGetImages: vi.fn(),
    mockGetPaidAccess: vi.fn(),
  })
);

vi.mock('~/server/services/model.service', () => ({
  getModelsWithVersions: mockGetModelsWithVersions,
  getVaeFiles: mockGetVaeFiles,
}));
vi.mock('~/server/services/model-version.service', () => ({
  publicModelResponseKey: (id: number, browsingLevel: number) =>
    `packed:caches:public-model-response:${id}:${browsingLevel}`,
}));
vi.mock('~/server/services/image.service', () => ({ getImagesForModelVersion: mockGetImages }));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: mockGetPaidAccess,
  toPublicPaidAccessDto: () => null,
  bustModelSaleCache: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  hasValidCreatorMembershipCached: async () => false,
}));
// Real naming helper on purpose: the sibling route tests stub getDownloadFilename, which is
// exactly what hides a route handing it a file with `metadata` already destructured off.
vi.mock('~/server/services/file.service', async () => {
  const { resolveModelFileName } = await import('~/utils/model-file-naming');
  return { getDownloadFilename: resolveModelFileName };
});
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: vi.fn(),
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => handler(req, res),
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: any) => (req: any, res: any) => handler(req, res),
  MixedAuthEndpoint: (handler: any) => handler,
  handleEndpointError: (res: any, e: any) => res.status(500).json({ error: String(e) }),
}));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => 'US',
  isRegionRestricted: () => false,
}));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/utils/url-helpers', () => ({ getBaseUrl: () => 'https://civitai.com' }));

const MODEL = { id: 7, name: 'Qwen Image', type: 'Checkpoint', mode: null };
const VERSION_ID = 4242;

const FILES = [
  {
    id: 11,
    modelVersionId: VERSION_ID,
    type: 'Model',
    visibility: 'Public',
    sizeKB: 1111,
    url: 's3://a',
    name: 'qwen_image.safetensors',
    overrideName: null,
    hashes: [{ type: 'SHA256', hash: 'aaaa1111' }],
    metadata: { format: 'SafeTensor', size: 'full', fp: 'bf16' },
  },
  {
    id: 12,
    modelVersionId: VERSION_ID,
    type: 'Model',
    visibility: 'Public',
    sizeKB: 2222,
    url: 's3://b',
    name: 'qwen_image.safetensors',
    overrideName: null,
    hashes: [{ type: 'SHA256', hash: 'bbbb2222' }],
    metadata: { format: 'SafeTensor', size: 'full', fp: 'fp8' },
  },
  {
    id: 13,
    modelVersionId: VERSION_ID,
    type: 'Model',
    visibility: 'Public',
    sizeKB: 3333,
    url: 's3://c',
    name: 'qwen_image_small.safetensors',
    overrideName: 'creator-picked.safetensors',
    hashes: [{ type: 'SHA256', hash: 'cccc3333' }],
    metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
  },
];

const EXPECTED_NAMES = FILES.map((file) =>
  resolveModelFileName({
    model: MODEL as any,
    modelVersion: { name: 'v1' },
    file,
    versionFiles: FILES,
  })
);

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

async function namesFromModelsById() {
  const mod = await import('~/pages/api/v1/models/[id]');
  const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  const req = {
    method: 'GET',
    query: { id: String(MODEL.id) },
    headers: { host: 'civitai.com' },
    url: `/api/v1/models/${MODEL.id}`,
  } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  expect(res.statusCode).toBe(200);
  return res.body.modelVersions[0].files as any[];
}

async function namesFromModelVersionsById() {
  const mod = await import('~/pages/api/v1/model-versions/[id]');
  const body = await mod.prepareModelVersionResponse(
    {
      id: VERSION_ID,
      modelId: MODEL.id,
      name: 'v1',
      baseModel: 'SD 1.5',
      status: 'Published',
      nsfwLevel: 1,
      licensingFee: null,
      files: FILES.map((f) => ({ ...f })),
      metrics: [{ downloadCount: 5, thumbsUpCount: 2 }],
      model: { ...MODEL, nsfw: false, poi: false },
    } as any,
    new URL('https://civitai.com'),
    [],
    null
  );
  return body!.files as any[];
}

const byId = (files: any[]) => [...files].sort((a, b) => a.id - b.id);

describe('v1 files[].name — by-id routes name the file from its metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetModelsWithVersions.mockImplementation(async () => ({
      items: [
        {
          ...MODEL,
          tagsOnModels: [],
          user: { username: 'creator', image: null, profilePicture: null },
          modelVersions: [
            {
              id: VERSION_ID,
              name: 'v1',
              status: 'Published',
              files: FILES.map((f) => ({ ...f })),
              images: [],
            },
          ],
        },
      ],
    }));
    mockGetVaeFiles.mockResolvedValue([]);
    mockGetImages.mockResolvedValue([]);
    mockGetPaidAccess.mockResolvedValue({});
  });

  it('the fixture itself tells the two Model files apart by precision, not by id', () => {
    expect(EXPECTED_NAMES[0]).toMatch(/_full_bf16\.safetensors$/);
    expect(EXPECTED_NAMES[1]).toMatch(/_full_fp8\.safetensors$/);
    expect(EXPECTED_NAMES[2]).toBe('creator-picked.safetensors');
  });

  it('GET /api/v1/models/:id', async () => {
    const names = byId(await namesFromModelsById()).map((f) => f.name);
    expect(names).toEqual(EXPECTED_NAMES);
    for (const name of names) expect(name).not.toMatch(/_1[123]\.safetensors$/);
  });

  it('GET /api/v1/model-versions/:id (and by-hash, which shares the builder)', async () => {
    const files = byId(await namesFromModelVersionsById());
    expect(files.map((f) => f.name)).toEqual(EXPECTED_NAMES);
    for (const file of files) {
      expect(file.name).not.toMatch(/_1[123]\.safetensors$/);
      expect(Object.keys(file)).not.toContain('overrideName');
    }
  });

  it('both routes agree with each other', async () => {
    const a = byId(await namesFromModelsById()).map((f) => f.name);
    const b = byId(await namesFromModelVersionsById()).map((f) => f.name);
    expect(a).toEqual(b);
  });

  // Textual pin: the parity cases feed prepareModelVersionResponse directly, so nothing in this
  // suite executes the SQL that must select `overrideName` for the helper to honour it.
  it('the model-versions SQL selects overrideName next to name', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../../pages/api/v1/model-versions/[id].ts'),
      'utf8'
    );
    expect(source).toContain(`'name', mf.name,`);
    expect(source).toContain(`'overrideName', mf."overrideName",`);
  });
});
