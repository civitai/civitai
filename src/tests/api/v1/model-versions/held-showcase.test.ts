import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { NsfwLevel } from '~/server/common/enums';

/**
 * GET /api/v1/model-versions/[id], by-hash/[hash] and the POST by-hash batch all shape their body
 * through `prepareModelVersionResponse`, which serves a showcase only as `holdShowcaseImages`
 * returns it. The hold itself is covered in model.service.v1-showcase-hold.test.ts.
 */

const {
  mockGetVaeFiles,
  mockGetImages,
  mockGetPaidAccess,
  mockFindUnique,
  mockFileFindFirst,
  mockHold,
} = vi.hoisted(() => ({
  mockGetVaeFiles: vi.fn(),
  mockGetImages: vi.fn(),
  mockGetPaidAccess: vi.fn(),
  mockFindUnique: vi.fn(),
  mockFileFindFirst: vi.fn(),
  mockHold: vi.fn(),
}));

vi.mock('~/server/db/client', () => {
  const stub = {
    modelVersion: { findUnique: mockFindUnique },
    // by-hash/[hash] resolves the version through modelFile.findFirst.
    modelFile: { findFirst: mockFileFindFirst },
    $queryRaw: vi.fn(),
  };
  // The page module's transitive graph reaches for several named exports of this
  // client; a partial mock makes Vitest throw on the first one it can't find.
  return { dbRead: stub, dbWrite: stub, dbKV: stub, dbReadLong: stub, dbReadReplica: stub };
});
// The metric-privacy read (`prepareModelVersionResponse`) is a Kysely statement; no row is a version
// with no privacy inputs, as the Prisma `null` was.
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  getModelVersionPrivacyRow: vi.fn(async () => undefined),
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
// The listing rule is tested on PGlite (training-data-share.behavior.test.ts); here only that this
// surface asks it with the request's host and applies the answer.
vi.mock('~/server/services/training-data-restricted.service', () => ({
  trainingDataListing:
    async (
      _db: unknown,
      _versions: unknown,
      { redCapable, viewerManages }: { redCapable: boolean; viewerManages?: boolean }
    ) =>
    (file: { type: string }) =>
      file.type !== 'Training Data' || redCapable || !!viewerManages,
}));
vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isRedCapableHost: (host?: string | null) => host === 'civitai.red',
}));
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
      minor: true,
      sfwOnly: false,
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

const servedUrls = (body: any) => body.images.map((i: any) => i.url);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetVaeFiles.mockResolvedValue([]);
  mockGetImages.mockResolvedValue(SHOWCASE);
  mockGetPaidAccess.mockResolvedValue({});
  // Stand-in for the hold on a held model: keeps only the PG image.
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
  it('serves the showcase it reads only as the hold returns it, keyed to its model', async () => {
    const body = await prepare();
    expect(servedUrls(body)).toEqual(['u2']);
    expect(mockHold).toHaveBeenCalledTimes(1);
    const [byVersion, models] = mockHold.mock.calls[0];
    expect(Object.keys(byVersion)).toEqual([String(VERSION)]);
    expect(models.get(VERSION)).toEqual({ modelId: MODEL, minor: true, sfwOnly: false });
    expect(body!.model).not.toHaveProperty('minor');
    expect(body!.model).not.toHaveProperty('sfwOnly');
  });

  it('holds images handed in by the by-hash batch the same way', async () => {
    const body = await prepare(SHOWCASE);
    expect(mockGetImages).not.toHaveBeenCalled();
    expect(servedUrls(body)).toEqual(['u2']);
  });

  it('serves the whole showcase when the hold keeps it', async () => {
    mockHold.mockImplementation(async (byVersion: unknown) => byVersion);
    const body = await prepare();
    expect(servedUrls(body)).toEqual(['u1', 'u2']);
  });
});
