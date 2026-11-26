import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import { NsfwLevel } from '~/server/common/enums';

const { mockIsRegionRestricted } = vi.hoisted(() => ({ mockIsRegionRestricted: vi.fn() }));

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CIVITAI_LINK ??= 'https://link.example.test';
});
vi.mock('@civitai/next-axiom', () => ({
  withAxiom:
    (h: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      h(...args),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn().mockResolvedValue(null),
}));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  getModelVersionPrivacyRow: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/model.service', () => ({
  getVaeFiles: vi.fn(async () => []),
  holdShowcaseImages: async (byVersion: unknown) => byVersion,
}));
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
  getDownloadFilename: ({ file }: { file: { id: number } }) => `${file.id}.safetensors`,
}));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => ({ countryCode: 'XX' }),
  isRegionRestricted: mockIsRegionRestricted,
}));

import { createRealApiPair } from '~/server/utils/__tests__/real-api-response';
import handler from '~/pages/api/v1/model-versions/by-hash/[hash]';

const { PG, PG13, R, X } = NsfwLevel;

function version(nsfwLevel: number) {
  return {
    id: 100,
    modelId: 10,
    name: 'v1',
    baseModel: 'SD 1.5',
    status: 'Published',
    availability: 'Public',
    nsfwLevel,
    licensingFee: null,
    files: [
      {
        id: 1000,
        type: 'Model',
        visibility: 'Public',
        sizeKB: 1,
        modelVersionId: 100,
        url: 's3://a',
        name: 'a.safetensors',
        hashes: [{ type: 'SHA256', hash: 'AAAA' }],
        metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
      },
    ],
    metrics: [],
    model: {
      name: 'Model 10',
      sfwName: null,
      type: 'Checkpoint',
      nsfw: false,
      poi: false,
      mode: null,
      availability: 'Public',
      userId: 7,
      minor: false,
      sfwOnly: false,
    },
  };
}

/** The same URL from both sides of the region line, through the REAL `PublicEndpoint`. */
async function bothRegions(row: unknown) {
  const answers = [];
  for (const restricted of [false, true]) {
    mockIsRegionRestricted.mockReturnValue(restricted);
    dbMock.dbRead.modelFile.findFirst.mockResolvedValueOnce({
      modelVersion: structuredClone(row),
    } as never);
    const { req, res, header } = createRealApiPair({
      url: '/api/v1/model-versions/by-hash/AAAA',
      query: { hash: 'AAAA' },
    });
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
    answers.push({ statusCode: res.statusCode, cacheControl: header('Cache-Control') });
  }
  const [elsewhere, restricted] = answers;
  return { elsewhere, restricted };
}

describe('GET /api/v1/model-versions/by-hash/[hash] by region', () => {
  beforeEach(() => {
    dbMock.dbRead.modelFile.findFirst.mockReset();
    mockIsRegionRestricted.mockReset();
  });

  it.each([
    ['an R version', R],
    ['an X version', X],
  ])(
    '404s %s in a restricted region, serves it elsewhere, and caches neither',
    async (_, level) => {
      const { elsewhere, restricted } = await bothRegions(version(level));

      expect(elsewhere.statusCode).toBe(200);
      expect(restricted.statusCode).toBe(404);
      for (const { cacheControl } of [elsewhere, restricted])
        expect(cacheControl).not.toMatch(/public|s-maxage/);
    }
  );

  it('serves a PG|R version in both regions, as by id, and caches neither', async () => {
    const { elsewhere, restricted } = await bothRegions(version(PG | R));

    expect(elsewhere.statusCode).toBe(200);
    expect(restricted.statusCode).toBe(200);
    for (const { cacheControl } of [elsewhere, restricted])
      expect(cacheControl).not.toMatch(/public|s-maxage/);
  });

  it('404s an unrated version in both regions', async () => {
    const { elsewhere, restricted } = await bothRegions(version(0));

    expect(elsewhere.statusCode).toBe(404);
    expect(restricted.statusCode).toBe(404);
  });

  it('serves an SFW version in both regions; elsewhere it stays publicly cached', async () => {
    const { elsewhere, restricted } = await bothRegions(version(PG | PG13));

    expect(elsewhere.statusCode).toBe(200);
    expect(restricted.statusCode).toBe(200);
    expect(elsewhere.cacheControl).toMatch(/^public, s-maxage=3600/);
  });
});
