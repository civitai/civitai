import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/redis.mock';
import '~/__tests__/mocks/logging.mock';
import type * as ResourceDataRedis from '~/server/redis/resource-data.redis';

/**
 * The resource data shape: what `getResourceData` makes of a version row's columns and its
 * settings JSON. The graph, the cards and the public projection all read this shape, and every
 * other test of them hand-builds it, so this is the one place a wrong mapping shows.
 */
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('~/server/redis/resource-data.redis', async (importOriginal) => ({
  ...(await importOriginal<typeof ResourceDataRedis>()),
  resourceDataCache: { fetch: fetchMock, bust: vi.fn() },
}));
vi.mock('~/server/prom/client', () => ({
  cacheHitCounter: { inc: vi.fn() },
  cacheMissCounter: { inc: vi.fn() },
  cacheRevalidateCounter: { inc: vi.fn() },
  cacheFailOpenDegradedCounter: { inc: vi.fn() },
  cacheFailOpenOriginFetchCounter: { inc: vi.fn() },
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: {} }));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(async () => ({
    modelVersion: { findMany: vi.fn(async () => []) },
  })),
}));
vi.mock('~/server/services/model.service', () => ({ getFeaturedModels: vi.fn(async () => []) }));
vi.mock('~/server/services/model-file.service', () => ({
  getFilesForModelVersionCache: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/model-version.service', () => ({
  getLinkedVaeIds: vi.fn(),
  bustMvCache: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { fetch: vi.fn(async () => ({})) },
}));
vi.mock('~/server/services/generation/paid-access-gating', () => ({
  applyPaidAccessGating: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/generation/version-generation-state.service', () => ({
  getVisibleSystemWildcardSetIdsByVersionId: vi.fn(async () => new Map()),
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { GENERATION_TESTING: 'generation-testing' },
  isFlipt: vi.fn(async () => false),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

import {
  getResourceData,
  swapGenerationAliases,
  weightImageResources,
} from '~/server/services/generation/generation.service';

const VERSION_ID = 5151;

const dbRow = (over: Record<string, unknown> = {}) => ({
  id: VERSION_ID,
  name: 'v1',
  trainedWords: [],
  clipSkip: null,
  vaeId: null,
  baseModel: 'MOSS Image',
  settings: null,
  availability: 'Public',
  aliasId: null,
  covered: true,
  coveredNext: true,
  status: 'Published',
  flags: 0,
  generatorLoaded: true,
  hasAccess: true,
  model: { id: 99, name: 'A Model', type: 'LORA', nsfw: false, poi: false, userId: 777 },
  ...over,
});

beforeEach(() => {
  fetchMock.mockReset();
});

const fetchOne = async (row: ReturnType<typeof dbRow>) => {
  fetchMock.mockResolvedValue([row]);
  const [resource] = await getResourceData([VERSION_ID], { user: {} });
  return resource;
};

describe('getResourceData: the resource data shape', () => {
  it('lifts the columns and the settings JSON into settings, the turbo flag and the bands', async () => {
    const band = {
      steps: { min: 4, max: 8, default: 8 },
      cfgScale: { min: 1, max: 1, default: 1 },
    };
    const resource = await fetchOne(
      dbRow({
        clipSkip: 2,
        settings: {
          minStrength: 0.2,
          maxStrength: 1.4,
          strength: 0.9,
          turbo: band,
          generation: { turboLora: { id: 77, strength: 0.6 } },
        },
      })
    );
    expect(resource.settings).toEqual({
      strength: { min: 0.2, max: 1.4, default: 0.9 },
      clipSkip: 2,
      turboLora: { id: 77, strength: 0.6 },
    });
    expect(resource.turbo).toBe(true);
    expect(resource.recommendedSettings).toEqual(band);
    // The data carries no weight; a value takes one from `settings.strength.default`.
    for (const gone of [
      'strength',
      'minStrength',
      'maxStrength',
      'clipSkip',
      'vaeId',
      'turboLora',
    ]) {
      expect(resource).not.toHaveProperty(gone);
    }
  });

  it('a version with no settings gets the default range and no flag, band or companions', async () => {
    const resource = await fetchOne(dbRow());
    expect(resource.settings).toEqual({ strength: { min: -1, max: 2, default: 1 } });
    expect(resource).not.toHaveProperty('turbo');
    expect(resource).not.toHaveProperty('recommendedSettings');
  });
});

// The call site, not the helper, is what can drop the image's strength.
describe('weightImageResources', () => {
  it("takes the image's recorded weight and falls back to the version default", async () => {
    const recorded = { ...(await fetchOne(dbRow({ settings: { strength: 0.9 } }))), id: 1 };
    const unrecorded = { ...(await fetchOne(dbRow({ settings: { strength: 0.6 } }))), id: 2 };
    const weighted = weightImageResources(
      [recorded, unrecorded],
      [{ modelVersionId: 1, strength: 0.4 }]
    );
    expect(weighted.map((r) => r.strength)).toEqual([0.4, 0.6]);
  });
});

// A cover resource redirects to its alias target; the image's weight must ride across.
describe('swapGenerationAliases', () => {
  it("carries the image's weight onto the alias target", async () => {
    const cover = { ...(await fetchOne(dbRow({ settings: { strength: 0.9 } }))), aliasId: 2 };
    const target = dbRow({ id: 2, settings: { strength: 0.9 } });
    fetchMock.mockResolvedValue([target]);
    const [swapped] = await swapGenerationAliases([{ ...cover, strength: 0.4, air: 'urn:air:x' }], {
      user: {},
    });
    expect(swapped).toMatchObject({ id: 2, strength: 0.4 });
  });
});
