import { describe, it, expect, vi, beforeEach } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { NsfwLevel } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * GET /api/v1/model-versions/[id], by-hash/[hash] and the POST by-hash batch all shape their body
 * through `prepareModelVersionResponse`. A minor or SFW-only model's showcase is served there only
 * within its gallery level. `holdShowcaseImages` itself is covered in hold-showcase-images.test.ts;
 * this pins that the response is built from what it returns, for both image sources.
 */

const { mockGetVaeFiles, mockGetImages, mockGetPaidAccess, mockHold } = vi.hoisted(() => ({
  mockHold: vi.fn(),
  mockGetVaeFiles: vi.fn(),
  mockGetImages: vi.fn(),
  mockGetPaidAccess: vi.fn(),
}));

vi.mock('~/server/services/model.service', () => ({
  getVaeFiles: mockGetVaeFiles,
  holdShowcaseImages: mockHold,
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: mockGetImages,
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: mockGetPaidAccess,
  toPublicPaidAccessDto: () => null,
  bustModelSaleCache: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  hasValidCreatorMembershipCached: async () => false,
}));
const mockGetDownloadFilename = vi.hoisted(() =>
  vi.fn(({ file }: any) => `${file.id}.safetensors`)
);
vi.mock('~/server/services/file.service', () => ({
  getDownloadFilename: mockGetDownloadFilename,
}));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint: (handler: any) => handler,
  // by-hash/[hash] is wrapped in PublicEndpoint(handler, ['GET'], {maxAge}).
  PublicEndpoint: (handler: any) => handler,
}));
const region = vi.hoisted(() => ({ restricted: false }));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => 'US',
  isRegionRestricted: () => region.restricted,
}));

const VERSION = 4242;
const MODEL = 77;
const image = (id: number, nsfwLevel: number) => ({
  id,
  nsfwLevel,
  url: `u${id}`,
  userId: 7,
  name: null,
  modelVersionId: VERSION,
  type: 'image',
  width: 1,
  height: 1,
  hash: null,
  meta: null,
});
const SHOWCASE = [image(1, NsfwLevel.X), image(2, NsfwLevel.PG)];

function modelVersion() {
  return {
    id: VERSION,
    modelId: MODEL,
    name: 'v1',
    baseModel: 'SD 1.5',
    status: 'Published',
    availability: 'Public',
    nsfwLevel: 1,
    licensingFee: null,
    files: [
      {
        id: 21,
        type: 'Model',
        visibility: 'Public',
        sizeKB: 1,
        modelVersionId: VERSION,
        url: 's3://a',
        name: 'a.safetensors',
        hashes: [{ type: 'SHA256', hash: 'aaaa' }],
        metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
      },
    ],
    metrics: [],
    model: {
      name: 'M',
      type: 'LORA',
      nsfw: false,
      poi: false,
      mode: null,
      availability: 'Public',
      userId: 7,
    },
  } as any;
}

async function prepare(images?: unknown[]) {
  const mod = await import('~/pages/api/v1/model-versions/[id]');
  return mod.prepareModelVersionResponse(
    modelVersion(),
    new URL('https://civitai.com'),
    images as any,
    null
  );
}

const servedIds = (body: any) => body.images.map((i: any) => i.url);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetVaeFiles.mockResolvedValue([]);
  mockGetImages.mockResolvedValue(SHOWCASE);
  mockGetPaidAccess.mockResolvedValue({});
  dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(null);
  // Stand-in for the hold on a held model: keeps only images within PG.
  mockHold.mockImplementation(
    async (byVersion: Record<number, { images: { nsfwLevel: number }[] }>) =>
      Object.fromEntries(
        Object.entries(byVersion).map(([id, entry]) => [
          id,
          { ...entry, images: entry.images.filter((i) => i.nsfwLevel === NsfwLevel.PG) },
        ])
      )
  );
});

describe('a model version response', () => {
  it('serves the showcase it reads only as the hold returns it, placed on the model', async () => {
    const body = await prepare();
    expect(servedIds(body)).toEqual(['u2']);
    expect(mockHold).toHaveBeenCalledTimes(1);
    const [byVersion, opts] = mockHold.mock.calls[0];
    expect(Object.keys(byVersion)).toEqual([String(VERSION)]);
    expect(opts.models.get(VERSION)).toEqual({ modelId: MODEL });
    expect(opts.viewer).toBeUndefined();
  });

  it('holds images handed in by a batch the same way', async () => {
    const body = await prepare(SHOWCASE);
    expect(mockGetImages).not.toHaveBeenCalled();
    expect(servedIds(body)).toEqual(['u2']);
  });

  it('serves the whole showcase when the hold keeps it', async () => {
    mockHold.mockImplementation(async (byVersion: unknown) => byVersion);
    const body = await prepare();
    expect(servedIds(body)).toEqual(['u1', 'u2']);
  });
});
