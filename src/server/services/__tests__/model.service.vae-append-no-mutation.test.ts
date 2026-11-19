import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

/**
 * 🔴 CALL-SITE coverage for the VAE-append mutation — the half of this fix that the
 * accessor tests structurally CANNOT see.
 *
 * `getModelsWithVersions` used to do `groupedFiles[version.id].files.push(...vaeFile)` on an
 * array owned by the version-file cache layer. Two independent things now stop that leaking:
 *
 *   (a) the call site builds a NEW array (`model.service.ts`), and
 *   (b) `getFilesForModelVersionCache` hands every caller its own copy
 *       (`model-file.service.ts`).
 *
 * Either one alone is sufficient, which is exactly the problem: with (b) in place, reverting
 * (a) is unobservable to every other test in the tree, so nothing pins the call site. Whoever
 * later concludes the accessor copy is redundant — e.g. while landing the deep-clone proposed
 * in issue #3872 — would delete (b) and silently restore the bug.
 *
 * This suite closes that circle. It mocks `getFilesForModelVersionCache` to return the RAW,
 * cache-owned array with no copy at all — i.e. it removes (b) — so the only thing that can keep
 * the caller's array intact is (a). Restoring the `push` at the call site turns the last
 * assertion red.
 *
 * It drives the REAL `getModelsWithVersions`; only its I/O surfaces are stubbed. See
 * `get-models-raw.transient-503.test.ts` for the same import-the-real-model.service scaffold
 * and why these particular modules must be stubbed (Prisma/redis clients instantiate at module
 * load; `image.service` breaks the `event-engine-common` submodule chain).
 *
 * 🔴 STATIC import, deliberately — `model.service` is a ~5000-line module whose cold transform
 * would otherwise be charged to one test's `testTimeout`. See that file's header.
 */

const VERSION_ID = 42;
const VAE_VERSION_ID = 77;
const MODEL_ID = 7;
const USER_ID = 5;

const { mockDbRead, mockGetFilesForModelVersionCache, mockCancellableQuery } = vi.hoisted(() => ({
  mockDbRead: {
    recommendedResource: { findMany: vi.fn() },
    modelFile: { findMany: vi.fn() },
    modelMetric: { findMany: vi.fn() },
    modelVersionMetric: { findMany: vi.fn() },
    modelVersion: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
  mockGetFilesForModelVersionCache: vi.fn(),
  mockCancellableQuery: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: { cancellableQuery: mockCancellableQuery },
  pgDbWrite: {},
  pgDbReadLong: {},
}));

// THE SEAM. Returning the cache's own array (no copy) is the whole point — it models the
// accessor with its forward-protection removed, so this suite grades the CALL SITE alone.
vi.mock('~/server/services/model-file.service', () => ({
  getFilesForModelVersionCache: mockGetFilesForModelVersionCache,
  deleteFilesForModelVersionCache: vi.fn(),
}));

vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn().mockResolvedValue({}),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn().mockResolvedValue(false),
  // No flag is known (as with no Flipt client), so `kysely-hot-reads-11` reads OFF unless a test
  // below turns it on. A client "exists", so the gate never tries to start Flipt.
  isFliptSync: vi.fn().mockReturnValue(null),
  getFliptClientSync: vi.fn(() => ({})),
}));
// `kysely-hot-reads-11`'s one statement and the lazily loaded Kysely clients: stubbed, so the ON
// case below can tell which path served the page's metrics and linked components.
vi.mock('@civitai/db-queries/hot-reads-11', () => ({ getModelsWithVersionsStatsRow: vi.fn() }));
const { kyselyReadSentinel } = vi.hoisted(() => ({ kyselyReadSentinel: { name: 'kyselyRead' } }));
vi.mock('~/server/db/kyselyDb.lazy', () => ({
  loadKyselyDb: async () => ({ kyselyRead: kyselyReadSentinel, kyselyWrite: {} }),
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
  getShowcaseImageFilter: vi.fn(async () => () => true),
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(),
  getPublicPaidAccessForModelVersions: vi.fn().mockResolvedValue({}),
  getModelPaidAccessGates: vi.fn().mockResolvedValue(new Map()),
  bustPaidAccessCache: vi.fn(),
  bustModelSaleCache: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  getValidCreatorMembershipMap: vi.fn().mockResolvedValue(new Map()),
  getUserMetricPrivacyDefaultsMap: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('~/server/services/user.service', () => ({
  deleteBasicDataForUser: vi.fn(),
  getCosmeticsForUsers: vi.fn().mockResolvedValue({}),
  getProfilePicturesForUsers: vi.fn().mockResolvedValue({}),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: vi.fn() }));
// This list must track model.service's own import list from this module. A missing name is not a
// test failure — vitest throws it during module evaluation, so the file collects ZERO tests and the
// run stays green with this guard silently absent.
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { fetch: vi.fn() },
  modelVersionPublicDonationGoalsCache: { fetch: vi.fn(), bust: vi.fn() },
  modelTagCache: { fetch: vi.fn(), bust: vi.fn() },
  modelVotableTagsCache: { fetch: vi.fn(), bust: vi.fn() },
  userBasicCache: { fetch: vi.fn().mockResolvedValue({}), bust: vi.fn() },
  userModelCountCache: { fetch: vi.fn(), bust: vi.fn() },
}));
// The package, not `importOriginal`: the shim connects real clients when it loads. Same spread as
// the global mock in src/__tests__/setup.ts.
vi.mock('~/server/redis/client', async () => ({
  ...(await import('@civitai/redis/client')),
  ...(await import('~/server/redis/sys-read-deadline')),
  redis: { packed: { get: async () => null, set: async () => undefined } },
  sysRedis: {},
}));

import { getModelsWithVersions } from '~/server/services/model.service';
import { dataForModelsCache } from '~/server/redis/caches';
import { getModelsWithVersionsStatsRow } from '@civitai/db-queries/hot-reads-11';
import { isFliptSync } from '~/server/flipt/client';
import { resetHotReads11GateForTests } from '~/server/services/hot-reads-11.reads';

/** One primary file, as the version-file cache stores it. */
function baseFile() {
  return {
    id: 1,
    name: 'base.safetensors',
    type: 'Model',
    modelVersionId: VERSION_ID,
    metadata: {},
    hashes: [],
  };
}

/** The linked VAE, which `getVaeFiles` reads straight from the DB (NOT from the cache). */
function vaeFileRow() {
  return {
    id: 900,
    name: 'linked.vae.safetensors',
    type: 'Model',
    modelVersionId: VAE_VERSION_ID,
    metadata: {},
    hashes: [],
  };
}

/**
 * Wire every I/O surface `getModelsWithVersions` touches for a one-model / one-version read
 * whose version has a linked VAE. Returns the array handed to the service as the cached
 * record's `files` — the object whose identity the assertions are about.
 */
function primeOneModelWithALinkedVae() {
  const cacheOwnedFiles = [baseFile()];

  mockCancellableQuery.mockResolvedValue({
    result: async () => [
      {
        id: MODEL_ID,
        userId: USER_ID,
        name: 'Boogu',
        cursorId: null,
        meta: null,
        rank: {
          downloadCount: 0,
          thumbsUpCount: 0,
          thumbsDownCount: 0,
          commentCount: 0,
          collectedCount: 0,
          tippedAmountCount: 0,
        },
      },
    ],
  });

  vi.mocked(dataForModelsCache.fetch).mockResolvedValue({
    [MODEL_ID]: {
      hashes: [],
      tags: [],
      versions: [
        {
          id: VERSION_ID,
          name: 'v1',
          status: 'Published',
          baseModel: 'SD 1.5',
          nsfwLevel: 1,
          availability: 'Public',
          covered: true,
          trainingStatus: null,
          earlyAccessTimeFrame: 0,
        },
      ],
    },
  } as never);

  mockDbRead.$queryRaw.mockResolvedValue([]);
  mockDbRead.modelMetric.findMany.mockResolvedValue([]);
  mockDbRead.modelVersionMetric.findMany.mockResolvedValue([]);
  mockDbRead.modelVersion.findMany.mockResolvedValue([{ id: VERSION_ID, meta: null }]);

  // The linked-component row that makes this version resolve a VAE.
  mockDbRead.recommendedResource.findMany.mockResolvedValue([
    {
      sourceId: VERSION_ID,
      resourceId: VAE_VERSION_ID,
      settings: { isLinkedComponent: true, componentType: 'VAE' },
    },
  ]);
  // getVaeFiles' own read.
  mockDbRead.modelFile.findMany.mockResolvedValue([vaeFileRow()]);

  mockGetFilesForModelVersionCache.mockResolvedValue({
    [VERSION_ID]: { modelVersionId: VERSION_ID, files: cacheOwnedFiles },
  });

  return cacheOwnedFiles;
}

function callGetModelsWithVersions() {
  return getModelsWithVersions({
    input: { browsingLevel: 1, take: 10, period: 'AllTime' } as never,
    user: { id: USER_ID, isModerator: true },
  });
}

describe('getModelsWithVersions — the linked-VAE append does NOT mutate the cache-owned files array', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POSITIVE CONTROL: the linked VAE really is appended to the returned version', async () => {
    primeOneModelWithALinkedVae();
    const { items } = await callGetModelsWithVersions();

    // Without this, the isolation assertion below could pass simply because no VAE was ever
    // resolved (a broken mock chain reads exactly like a correct call site).
    expect(items).toHaveLength(1);
    expect(items[0].modelVersions[0].files.map((f) => f.name)).toEqual([
      'base.safetensors',
      'linked.vae.safetensors',
    ]);
  });

  it('leaves the array it was handed UNCHANGED (kills the `files.push(...vaeFile)` mutant)', async () => {
    const cacheOwnedFiles = primeOneModelWithALinkedVae();
    expect(cacheOwnedFiles).toHaveLength(1); // sanity: one file before the call

    await callGetModelsWithVersions();

    // 🔴 The regression. `getFilesForModelVersionCache` is stubbed here to hand back the
    // cache's OWN array, so the accessor's defensive copy is out of the picture: if this array
    // grew, the call site mutated a value it does not own. In production that array is shared
    // by every caller joined to the same degraded single-flight, so the VAE would leak into
    // `generation.service` and `modelFile.getByVersionId`, and — via the 180s origin response
    // cache on the v1 models endpoint — into every later reader of that model id.
    expect(cacheOwnedFiles.map((f) => f.name)).toEqual(['base.safetensors']);
    expect(cacheOwnedFiles).toHaveLength(1);
  });

  // NOTE: there is deliberately NO `expect(items[0].modelVersions[0].files).not.toBe(cached)`
  // assertion here. The returned `files` is the output of a `.map()` over the list, so it is a
  // freshly allocated array on every path — that assertion passes even with the `push` mutant
  // restored (measured), i.e. it is vacuous. The array identity that matters is the INPUT one,
  // which is what the test above pins.
});

// Shares this file's scaffold: the same getModelsRaw read feeds the browse feed, associated
// resources and /api/v1/models, whose `flags` is a published field.
describe('getModelsWithVersions serves flags without the partner bits', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [0, 0],
    [8, 8],
    [32 | 64 | 8, 8],
    [32 | 2, 2],
  ])('stored %s is served as %s', async (stored, served) => {
    primeOneModelWithALinkedVae();
    const cached = (await dataForModelsCache.fetch([MODEL_ID])) as never as Record<
      number,
      { versions: Record<string, unknown>[] }
    >;
    cached[MODEL_ID].versions[0].flags = stored;
    vi.mocked(dataForModelsCache.fetch).mockResolvedValue(cached as never);

    const { items } = await callGetModelsWithVersions();
    expect(items).toHaveLength(1);
    expect(items[0].modelVersions[0].flags).toBe(served);
  });
});

// Shares this file's scaffold: `kysely-hot-reads-11` ON must feed the SAME page from the one Kysely
// statement. The Prisma mocks stay primed with different values, so every asserted value below can
// only have come from the Kysely row.
describe('getModelsWithVersions with kysely-hot-reads-11 on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHotReads11GateForTests();
  });
  afterEach(() => {
    vi.mocked(isFliptSync).mockReset().mockReturnValue(null);
    resetHotReads11GateForTests();
  });

  it("serves the page's linked VAE, metrics and version meta from the Kysely row", async () => {
    vi.mocked(isFliptSync).mockImplementation((key) =>
      key === 'kysely-hot-reads-11' ? true : null
    );
    primeOneModelWithALinkedVae();
    // Prisma would say: no metrics, no meta. Kysely says otherwise.
    vi.mocked(getModelsWithVersionsStatsRow).mockResolvedValue({
      vaeLinks: [
        {
          sourceId: VERSION_ID,
          resourceId: VAE_VERSION_ID,
          settings: { isLinkedComponent: true, componentType: 'VAE' },
        },
      ],
      modelMetrics: [
        {
          modelId: MODEL_ID,
          downloadCount: 7101,
          thumbsUpCount: 7102,
          thumbsDownCount: 7103,
          commentCount: 7104,
          tippedAmountCount: 7105,
        },
      ],
      versionMetrics: [
        {
          modelVersionId: VERSION_ID,
          downloadCount: 7201,
          thumbsUpCount: 7202,
          thumbsDownCount: 7203,
        },
      ],
      versionMeta: [{ id: VERSION_ID, meta: {} }],
    } as never);

    const { items } = await callGetModelsWithVersions();

    expect(vi.mocked(getModelsWithVersionsStatsRow).mock.calls).toEqual([
      [kyselyReadSentinel, { modelIds: [MODEL_ID], modelVersionIds: [VERSION_ID] }],
    ]);
    for (const read of [
      mockDbRead.recommendedResource.findMany,
      mockDbRead.modelMetric.findMany,
      mockDbRead.modelVersionMetric.findMany,
      mockDbRead.modelVersion.findMany,
    ])
      expect(read).not.toHaveBeenCalled();
    expect(items).toHaveLength(1);
    // The moderator viewer sees every counter.
    expect(items[0].stats).toEqual({
      downloadCount: 7101,
      thumbsUpCount: 7102,
      thumbsDownCount: 7103,
      commentCount: 7104,
      tippedAmountCount: 7105,
    });
    expect(items[0].modelVersions[0].stats).toEqual({
      downloadCount: 7201,
      thumbsUpCount: 7202,
      thumbsDownCount: 7203,
    });
    expect(items[0].modelVersions[0].files.map((f) => f.name)).toEqual([
      'base.safetensors',
      'linked.vae.safetensors',
    ]);
  });
});
