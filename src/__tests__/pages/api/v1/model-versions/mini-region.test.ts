import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { NsfwLevel } from '~/server/common/enums';

/**
 * `GET /api/v1/model-versions/mini/[id]` by region: a restricted caller is served the levels
 * `/api/v1/model-versions/[id]` serves it, with the civitai.com name; a response that differs by
 * region is never shared-cached; the orchestrator, on its verified service token, is exempt.
 */

const { mockIsRegionRestricted } = vi.hoisted(() => ({ mockIsRegionRestricted: vi.fn() }));

vi.mock('~/server/services/orchestrator/refreshBlobs', () => ({ refreshBlobsService: vi.fn() }));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: async () => 'owner-token',
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  resolveCanGenerateForVersions: vi.fn(async () => new Map([[VERSION_ID, { canGenerate: true }]])),
  getShouldChargeForResources: vi.fn(async () => ({ 77: false })),
}));
vi.mock('~/server/services/model.service', () => ({ getFeaturedModels: vi.fn(async () => []) }));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => ({ countryCode: 'XX' }),
  isRegionRestricted: mockIsRegionRestricted,
}));
vi.mock('@civitai/next-axiom', () => ({
  withAxiom:
    (h: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      h(...args),
}));
// No caller here resolves to a user: anonymous, a stray bearer, and the orchestrator alike.
vi.mock('~/server/auth/api-auth-session', () => ({ getApiAuthSession: vi.fn(async () => null) }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));

import { createRealApiPair } from '~/server/utils/__tests__/real-api-response';
import handler from '~/pages/api/v1/model-versions/mini/[id]';

const { PG, PG13, R, X } = NsfwLevel;
const VERSION_ID = 555;
const SERVICE_TOKEN = 'test-service-token-0123456789abcdef';
const NO_STORE = 'private, no-store';

function versionRow(nsfwLevel: number, sfwName: string | null = null) {
  return {
    id: VERSION_ID,
    versionName: 'v1',
    availability: 'Public',
    publishedAt: new Date('2024-01-01T00:00:00Z'),
    modelId: 77,
    modelName: 'Red Name',
    sfwName,
    nsfwLevel,
    baseModel: 'SD 1.5',
    status: 'Published',
    type: 'Checkpoint',
    requireAuth: false,
    checkPermission: false,
    covered: true,
    isPromoted: false,
    generationAlias: null,
    minor: false,
    sfwOnly: false,
    usageControl: 'Download',
    modelUserId: 4242,
    poi: false,
    licensingFee: null,
    licensingFeeType: null,
    licensingFeeSettlementCurrency: null,
    isLicensingRoot: false,
    licensingSourceVersionId: null,
    sourceLicensingFeeRecipientUserId: null,
    sourceModelType: null,
    sourceBaseModel: null,
    sourceLicensingFee: null,
    sourceLicensingFeeType: null,
    sourceLicensingFeeSettlementCurrency: null,
    versionFlags: 0,
    userFlags: 0,
  };
}

const FILE = {
  id: 101,
  type: 'Model',
  visibility: 'Public',
  url: 'https://example.invalid/a.safetensors',
  metadata: { format: 'SafeTensor', size: 'full', fp: 'fp16' },
  sizeKB: 1024,
  name: 'model.safetensors',
  hashes: { SHA256: 'A'.repeat(64) },
};

/** One request through the REAL `MixedAuthEndpoint`, from a restricted region or not. */
async function call(row: object, restricted: boolean, authorization?: string) {
  mockIsRegionRestricted.mockReturnValue(restricted);
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw
    .mockResolvedValueOnce([structuredClone(row)])
    .mockResolvedValueOnce([structuredClone(FILE)]);
  const { req, res, header } = createRealApiPair({
    url: `/api/v1/model-versions/mini/${VERSION_ID}`,
    query: { id: String(VERSION_ID) },
    headers: { host: 'civitai.com', ...(authorization ? { authorization } : {}) },
  });
  let body: Record<string, unknown> | undefined;
  const json = res.json.bind(res);
  res.json = ((b: unknown) => {
    body = b as Record<string, unknown>;
    return json(b);
  }) as typeof res.json;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { statusCode: res.statusCode, body, cacheControl: header('Cache-Control') };
}

beforeEach(() => {
  setEnv({ ORCHESTRATOR_SERVICE_TOKEN: SERVICE_TOKEN });
  mockIsRegionRestricted.mockReset();
});

describe('mini/[id] by region', () => {
  it.each([
    ['an R version', R],
    ['an X version', X],
    ['an unrated version', 0],
  ])('404s %s in a restricted region, as an unknown id', async (_, level) => {
    const restricted = await call(versionRow(level), true);
    expect(restricted.statusCode).toBe(404);
    expect(restricted.body).toEqual({ error: 'Model not found' });
  });

  it.each([
    ['an R version', R],
    ['an X version', X],
  ])('serves %s elsewhere, and caches it in neither region', async (_, level) => {
    const elsewhere = await call(versionRow(level), false);
    const restricted = await call(versionRow(level), true);
    expect(elsewhere.statusCode).toBe(200);
    expect(elsewhere.body?.modelName).toBe('Red Name');
    for (const { cacheControl } of [elsewhere, restricted]) expect(cacheControl).toBe(NO_STORE);
  });

  it('serves a PG|R version in both regions, as by id, and caches neither', async () => {
    const elsewhere = await call(versionRow(PG | R), false);
    const restricted = await call(versionRow(PG | R), true);
    expect([elsewhere.statusCode, restricted.statusCode]).toEqual([200, 200]);
    for (const { cacheControl } of [elsewhere, restricted]) expect(cacheControl).toBe(NO_STORE);
  });

  it('serves the civitai.com name in a restricted region, and caches neither name', async () => {
    const elsewhere = await call(versionRow(PG, 'Com Name'), false);
    const restricted = await call(versionRow(PG, 'Com Name'), true);
    expect(elsewhere.body?.modelName).toBe('Red Name');
    expect(restricted.body?.modelName).toBe('Com Name');
    for (const { cacheControl } of [elsewhere, restricted]) expect(cacheControl).toBe(NO_STORE);
  });

  it('control: an SFW version with no civitai.com name keeps the public cache in both regions', async () => {
    for (const restricted of [false, true]) {
      const { statusCode, cacheControl } = await call(versionRow(PG | PG13), restricted);
      expect(statusCode).toBe(200);
      expect(cacheControl).toMatch(/^public, s-maxage=/);
    }
  });
});

describe('mini/[id] orchestrator exemption', () => {
  it('serves the orchestrator, on its verified token, an X version in a restricted region, uncached', async () => {
    const { statusCode, body, cacheControl } = await call(
      versionRow(X, 'Com Name'),
      true,
      `Bearer ${SERVICE_TOKEN}`
    );
    expect(statusCode).toBe(200);
    expect(body?.modelName).toBe('Red Name');
    expect(cacheControl).toBe(NO_STORE);
  });

  it.each([
    ['a wrong token', 'Bearer not-the-service-token-0123456789'],
    ['the token without the Bearer scheme', SERVICE_TOKEN],
    ['no token', undefined],
  ])('404s an X version in a restricted region for %s', async (_, authorization) => {
    const { statusCode, body } = await call(versionRow(X), true, authorization);
    expect(statusCode).toBe(404);
    expect(body).toEqual({ error: 'Model not found' });
  });

  it('is not granted while no service token is configured', async () => {
    setEnv({ ORCHESTRATOR_SERVICE_TOKEN: undefined });
    const { statusCode } = await call(versionRow(X), true, `Bearer ${SERVICE_TOKEN}`);
    expect(statusCode).toBe(404);
  });
});
