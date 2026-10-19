import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as CommonService from '~/server/services/common.service';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type * as GenerationService from '~/server/services/generation/generation.service';
import type * as PaidAccessService from '~/server/services/paid-access.service';
import type * as SystemCache from '~/server/services/system-cache';
import type * as UserService from '~/server/services/user.service';
import type * as Caches from '~/server/redis/caches';
import { ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * `model.getById` with the shared model-row cache on (`modelPublicPayloadCache`) against the same
 * handler with it off. The row is cached once and every viewer's payload is derived from it per
 * request, so for each viewer the two must be identical — and the viewers must differ from each
 * other, or the comparison would pass with a cache that froze one viewer's payload for everyone.
 *
 * Everything the handler reads besides the row is faked here as a function of the VIEWER, so a
 * per-viewer value that leaked through the cache would show up as a mismatch.
 */

const mocks = vi.hoisted(() => ({
  amIBlockedByUser: vi.fn(),
  hasEntityAccess: vi.fn(),
  getViewerMonetization: vi.fn(),
  resolveCanGenerateForVersions: vi.fn(),
  getResourceData: vi.fn(),
  coverageAudience: vi.fn(),
  getCategoryTags: vi.fn(),
  modelTagFetch: vi.fn(),
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: mocks.amIBlockedByUser,
}));
vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommonService>()),
  hasEntityAccess: mocks.hasEntityAccess,
}));
vi.mock('~/server/services/paid-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PaidAccessService>()),
  getViewerMonetization: mocks.getViewerMonetization,
}));
vi.mock('~/server/services/generation/generation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationService>()),
  resolveCanGenerateForVersions: mocks.resolveCanGenerateForVersions,
  getResourceData: mocks.getResourceData,
}));
vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverageSource>()),
  coverageAudience: mocks.coverageAudience,
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getCategoryTags: mocks.getCategoryTags,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return { ...actual, modelTagCache: { ...actual.modelTagCache, fetch: mocks.modelTagFetch } };
});

import { getModelHandler } from '~/server/controllers/model.controller';

const MODEL_ID = 4101;
const OWNER_ID = 4102;
const OTHER_ID = 4103;
const MOD_ID = 4104;
const DAY = 24 * 60 * 60 * 1000;
// Fixed once, so the uncached and cached reads of the fixture return the same instant.
const PUBLISHED_AT = new Date(Date.now() - DAY);

const VIEWERS = {
  anon: undefined,
  other: { id: OTHER_ID, isModerator: false },
  owner: { id: OWNER_ID, isModerator: false },
  moderator: { id: MOD_ID, isModerator: true },
} as const;
type ViewerKey = keyof typeof VIEWERS;

function file(id: number, visibility: 'Public' | 'Private', type = 'Model') {
  return {
    id,
    url: `https://files.example/${id}`,
    sizeKB: 1000 + id,
    name: `file-${id}.safetensors`,
    overrideName: null,
    type,
    visibility,
    metadata: { format: 'SafeTensor', trainingResults: { epochs: id }, selectedEpochUrl: 'e' },
    pickleScanResult: 'Success',
    pickleScanMessage: null,
    virusScanResult: 'Success',
    virusScanMessage: null,
    scannedAt: new Date('2026-10-01T00:00:00Z'),
    modelVersionId: 0,
    hashes: [{ type: 'SHA256', hash: `ABCDEF${id}` }],
  };
}

function version(id: number, status: ModelStatus, extra: Record<string, unknown> = {}) {
  return {
    id,
    modelId: MODEL_ID,
    name: `v${id}`,
    description: `<p>version ${id}</p>`,
    steps: 100 + id,
    epochs: 10,
    clipSkip: 2,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-02T00:00:00Z'),
    trainedWords: [`word${id}`],
    trainingStatus: null,
    trainingDetails: null,
    flags: 7,
    inaccurate: false,
    baseModel: 'SDXL 1.0',
    baseModelType: 'Standard',
    availability: 'Public',
    status,
    publishedAt: status === ModelStatus.Published ? PUBLISHED_AT : null,
    meta: { picFinderModelId: id },
    settings: { strength: 0.8 },
    requireAuth: false,
    nsfwLevel: 1,
    uploadType: 'Created',
    usageControl: 'Download',
    licensingFee: null,
    generatorLoaded: false,
    metrics: [
      {
        generationCount: 11,
        downloadCount: 22,
        thumbsUpCount: 33,
        thumbsDownCount: 1,
        earnedAmount: 44,
      },
    ],
    files: [file(id * 10 + 1, 'Public'), file(id * 10 + 2, 'Private', 'Training Data')],
    generationCoverage: { covered: true, coveredNext: false },
    recommendedResources: [],
    ...extra,
  };
}

/** The `modelWithDetailsSelect` row: a published model with one published and one draft version. */
function modelRow(name = 'Cached Model') {
  return {
    id: MODEL_ID,
    name,
    description: '<p>model</p>',
    poi: false,
    minor: false,
    sfwOnly: false,
    isOfficial: false,
    nsfwLevel: 1,
    nsfw: false,
    type: 'LORA',
    uploadType: 'Created',
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    deletedAt: null,
    deletedBy: null,
    status: ModelStatus.Published,
    checkpointType: null,
    allowNoCredit: true,
    allowCommercialUse: ['Image'],
    allowDerivatives: true,
    allowDifferentLicense: true,
    licenses: [],
    publishedAt: new Date('2026-09-01T00:00:00Z'),
    locked: false,
    meta: { commentsLocked: false },
    mode: null,
    availability: 'Public',
    lockedProperties: [],
    reportStats: null,
    user: {
      id: OWNER_ID,
      image: null,
      username: 'owner',
      deletedAt: null,
      rank: null,
      profilePicture: null,
      cosmetics: [],
    },
    modelVersions: [
      version(501, ModelStatus.Published, { licensingFee: new Prisma.Decimal('12.50') }),
      version(502, ModelStatus.Draft),
    ],
    metrics: [
      {
        downloadCount: 1,
        thumbsUpCount: 2,
        thumbsDownCount: 3,
        imageCount: 4,
        collectedCount: 5,
        tippedAmountCount: 6,
        generationCount: 7,
        commentCount: 8,
      },
    ],
  };
}

beforeEach(() => {
  resetSharedMocks();
  installFakeCacheRedis();
  vi.useRealTimers();

  mocks.amIBlockedByUser.mockResolvedValue(false);
  mocks.coverageAudience.mockResolvedValue({ next: false, member: false });
  mocks.getCategoryTags.mockResolvedValue([]);
  mocks.modelTagFetch.mockResolvedValue({});
  mocks.getResourceData.mockResolvedValue([]);
  // Per-viewer answers, keyed on who is asking.
  mocks.hasEntityAccess.mockImplementation(
    async ({ entityIds, userId }: { entityIds: number[]; userId?: number }) =>
      entityIds.map((entityId) => ({
        entityId,
        hasAccess: userId !== undefined,
        permissions: userId === OWNER_ID ? 31 : 1,
      }))
  );
  mocks.getViewerMonetization.mockImplementation(
    async ({
      versions,
      viewer,
    }: {
      versions: { id: number; licensingFee: number | null }[];
      viewer: { id?: number };
    }) =>
      Object.fromEntries(
        versions.map((v) => [
          v.id,
          { paidAccess: undefined, licensingFee: v.licensingFee, sale: null, viewer: viewer.id },
        ])
      )
  );
  mocks.resolveCanGenerateForVersions.mockImplementation(
    async (versions: { id: number }[], { user }: { user: { id?: number } }) =>
      new Map(versions.map((v) => [v.id, { canGenerate: user.id === OTHER_ID }]))
  );
  dbMock.dbRead.post.findMany.mockResolvedValue([{ id: 9001, modelVersionId: 501 }] as never);
  dbMock.dbRead.modelAssociations.count.mockResolvedValue(0 as never);
  dbMock.dbRead.model.findFirst.mockImplementation((async () => modelRow()) as never);
});

function getById(viewer: ViewerKey, cache: boolean, input: Record<string, unknown> = {}) {
  return getModelHandler({
    input: { id: MODEL_ID, ...input },
    ctx: {
      user: VIEWERS[viewer],
      features: cache ? { modelPublicPayloadCache: true } : {},
    },
  } as never);
}

const ALL_VIEWERS = Object.keys(VIEWERS) as ViewerKey[];

/** Every cache read or write that touched a model-row key. */
function modelRowCacheCalls() {
  const r = redisMock.redis;
  return [r.packed.get, r.packed.set, r.setNxKeepTtlWithEx]
    .flatMap((fn) => fn.mock.calls.map(([key]) => String(key)))
    .filter((key) => key.includes('model-detail-public'));
}

describe('model.getById with the shared model-row cache', () => {
  it('serves every viewer the payload the uncached handler builds, from one cached entry', async () => {
    const uncached = Object.fromEntries(
      await Promise.all(ALL_VIEWERS.map(async (v) => [v, await getById(v, false)] as const))
    );
    const rowReadsWithoutCache = dbMock.dbRead.model.findFirst.mock.calls.length;
    expect(rowReadsWithoutCache).toBe(ALL_VIEWERS.length);

    for (const viewer of ALL_VIEWERS) {
      expect(await getById(viewer, true), viewer).toEqual(uncached[viewer]);
    }

    // One read populated the entry; every later viewer was served from it, except the owner, who
    // is always given a fresh row.
    expect(dbMock.dbRead.model.findFirst.mock.calls.length - rowReadsWithoutCache).toBe(2);

    // The viewers really do get different payloads, so equality above is per viewer.
    const versionIds = (v: ViewerKey) => uncached[v].modelVersions.map((mv) => mv.id);
    expect(versionIds('anon')).toEqual([501]);
    expect(versionIds('moderator')).toEqual([501, 502]);
    expect(uncached.anon.modelVersions[0].flags).toBeUndefined();
    expect(uncached.moderator.modelVersions[0].flags).toBe(7);
    expect(uncached.anon.modelVersions[0].files.map((f) => f.visibility)).toEqual(['Public']);
    expect(uncached.owner.modelVersions[0].files.map((f) => f.visibility)).toEqual([
      'Public',
      'Private',
    ]);
    expect(uncached.other.modelVersions[0].canGenerate).toBe(true);
    expect(uncached.anon.modelVersions[0].canDownload).toBeFalsy();
  });

  it('serves a cached entry for anonymous and signed-in viewers alike, starting from either', async () => {
    const otherFirst = await getById('other', true);
    const anon = await getById('anon', true);
    expect(dbMock.dbRead.model.findFirst).toHaveBeenCalledTimes(1);
    expect(anon).toEqual(await getById('anon', false));
    expect(otherFirst).toEqual(await getById('other', false));
  });

  it("carries the version's Decimal licensing fee through the cache as the same number", async () => {
    await getById('anon', true); // populates
    mocks.getViewerMonetization.mockClear();
    await getById('anon', true); // served from the entry

    const [{ versions }] = mocks.getViewerMonetization.mock.calls[0] as [
      { versions: { id: number; licensingFee: number | null }[] }
    ];
    expect(versions).toEqual([{ id: 501, ownerId: OWNER_ID, licensingFee: 12.5 }]);
  });

  it('keeps training data in the cached entry when one caller asks for it to be stripped', async () => {
    const stripped = await getById('moderator', true, { excludeTrainingData: true });
    expect(stripped.modelVersions[0].files[0].metadata).not.toHaveProperty('trainingResults');

    const full = await getById('moderator', true);
    expect(dbMock.dbRead.model.findFirst).toHaveBeenCalledTimes(1);
    expect(full.modelVersions[0].files[0].metadata).toHaveProperty('trainingResults', {
      epochs: 5011,
    });
  });

  it('keeps training data for one request when a concurrent one strips it during a cache outage', async () => {
    // With the cache unreadable, concurrent requests for one model share a single database read.
    redisMock.redis.packed.get.mockRejectedValue(new Error('cache unavailable') as never);

    const [stripped, full] = await Promise.all([
      getById('moderator', true, { excludeTrainingData: true }),
      getById('moderator', true),
    ]);
    expect(dbMock.dbRead.model.findFirst).toHaveBeenCalledTimes(1);
    expect(stripped.modelVersions[0].files[0].metadata).not.toHaveProperty('trainingResults');
    expect(full.modelVersions[0].files[0].metadata).toHaveProperty('trainingResults', {
      epochs: 5011,
    });
  });

  it('gives the owner their own latest row, never the cached one', async () => {
    await getById('anon', true); // caches 'Cached Model'
    dbMock.dbRead.model.findFirst.mockImplementation((async () => modelRow('Renamed')) as never);

    expect((await getById('anon', true)).name).toBe('Cached Model');
    expect((await getById('owner', true)).name).toBe('Renamed');
  });

  it('with the flag off, never reads or writes the cache', async () => {
    for (const viewer of ALL_VIEWERS) await getById(viewer, false);
    expect(modelRowCacheCalls()).toEqual([]);
    expect(dbMock.dbRead.model.findFirst).toHaveBeenCalledTimes(ALL_VIEWERS.length);

    // Positive control: the same probe sees the cache once the flag is on.
    await getById('anon', true);
    expect(modelRowCacheCalls().length).toBeGreaterThan(0);
  });
});
