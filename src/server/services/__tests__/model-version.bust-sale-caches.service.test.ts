import { describe, it, expect, vi, beforeEach } from 'vitest';

// bustMvCache is the ONLY invalidation Creator Studio can reach: scheduling, cancelling, shortening and
// deepening a sale all POST /api/v1/model-versions/bust-cache, which calls it. A sale write moves two
// cached things — the per-model badge window AND the per-version gate row, which carries the sale
// windows the model page prices from — and only the first was busted, so for the rest of the hour the
// card and the page disagreed about the same sale. This pins both.
//
// The mock wall mirrors bust-public-model-response-cache.service.test.ts: model-version.service pulls
// the search-index / meili / prom graph at load.

const { envBox } = vi.hoisted(() => ({
  envBox: {
    IS_DATAPACKET: true,
    LOGGING: '',
    MEILI_CALL_CONCURRENCY: 50,
    SIGNALS_CALL_CONCURRENCY: 30,
    S3_UPLOAD_ENDPOINT: 'http://localhost:9000',
    S3_IMAGE_UPLOAD_ENDPOINT: 'http://localhost:9000',
  } as Record<string, unknown>,
}));

vi.mock('~/env/server', () => ({
  env: new Proxy(envBox, { get: (t, p: string) => (p in t ? t[p] : undefined) }),
}));

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { refresh: vi.fn() },
  modelVersionAccessCache: { refresh: vi.fn() },
}));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: { bust: vi.fn() } }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate: vi.fn() } }));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedLinkDomain: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/donation-goal.service', () => ({ checkDonationGoalComplete: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { refresh: vi.fn() },
  uploadImageFromUrl: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ addPostImage: vi.fn(), createPost: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({ updateModelLastVersionAt: vi.fn() }));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
}));
// Spread the real module: hand-listing its exports couples this file to model-version.service's whole
// import graph, and the next export it reaches for would fail to load here rather than fail a test.
vi.mock('~/server/services/paid-access.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bustModelSaleCache: vi.fn(),
  bustPaidAccessCache: vi.fn(),
}));

import { bustMvCache } from '~/server/services/model-version.service';
import { bustModelSaleCache, bustPaidAccessCache } from '~/server/services/paid-access.service';
import { modelsSearchIndex } from '~/server/search-index';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('bustMvCache', () => {
  // 🔴 Do not delete either assertion because "the badge bust covers it". They are different caches with
  // different keys: the badge is per MODEL, the gate row is per VERSION, and the model page reads the
  // price from the gate row. Dropping the second one restores a sale that badges on the card and shows
  // full price on the page for up to an hour (CU 868kwp6ne).
  it('busts the sale-window caches on both sides of the display path', async () => {
    await bustMvCache([11, 22], [7]);

    expect(bustModelSaleCache).toHaveBeenCalledWith([11, 22]);
    expect(bustPaidAccessCache).toHaveBeenCalledWith('ModelVersion', [11, 22]);
    // Once each. A consolidation that folds a second bust in at a caller is otherwise invisible here.
    expect(bustModelSaleCache).toHaveBeenCalledTimes(1);
    expect(bustPaidAccessCache).toHaveBeenCalledTimes(1);
  });

  it('busts them for a single id passed unwrapped', async () => {
    await bustMvCache(11);

    expect(bustPaidAccessCache).toHaveBeenCalledWith('ModelVersion', [11]);
  });

  // The badge bust is deliberately swallowed — a stale badge must not fail an unpublish. That must not
  // take the gate-row bust down with it, which is what putting them in one try block would do.
  it('still busts the gate row when the badge bust throws', async () => {
    vi.mocked(bustModelSaleCache).mockRejectedValueOnce(new Error('redis down'));

    await expect(bustMvCache([11])).resolves.toBeUndefined();
    expect(bustPaidAccessCache).toHaveBeenCalledWith('ModelVersion', [11]);
  });

  // And the other direction. Note what this does NOT establish: the five busts between this one and the
  // enqueue are unguarded, so any of them throwing still loses it. This pins only that the two sale
  // busts are not what stops it.
  it('still reaches the search-index enqueue when the gate-row bust throws', async () => {
    vi.mocked(bustPaidAccessCache).mockRejectedValueOnce(new Error('redis down'));

    await expect(bustMvCache([11], [7])).resolves.toBeUndefined();
    expect(modelsSearchIndex.queueUpdate).toHaveBeenCalled();
  });
});
