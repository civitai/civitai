import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MeiliClient from '~/server/meilisearch/client';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type * as ModelsIndex from '~/server/search-index/models.search-index';
import { ModelVersionPricingSignal } from '@civitai/buzz';

/**
 * The clause is built by a tested pure function, but nothing asserted it reached a query. These read
 * the `filter` string the Meilisearch client is actually handed, so dropping
 * `modelPricingFilterClause(...)` from `buildFilter` fails here rather than shipping a chip that
 * filters nothing. The other end of the wire — the hook passing `hidePaid` at all — is pinned by
 * useResourceSelectInfinite.input.test.ts.
 */

const searchWithSignal = vi.fn();
const fetchThroughCache = vi.fn();
const getModelSearchIndexRecords = vi.fn();

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  searchClient: { index: () => ({}) },
  searchWithSignal: (...args: unknown[]) => searchWithSignal(...args),
  withMeiliResourceSelect: (fn: (signal?: AbortSignal) => unknown) => fn(undefined),
  isTransientMeiliError: () => false,
}));

// Hand-listed rather than spread, deliberately: `model.service` is a hub, and `importOriginal` here
// drags its whole transitive graph into a suite that only needs four empty tab resolvers. The cost is
// that a NEW import from it in resource-select.service.ts breaks this suite at load — see the
// cache-helpers mock below for the opposite trade and why it had to go the other way.
vi.mock('~/server/services/model.service', () => ({
  getFeaturedModels: vi.fn(async () => []),
  getRecentlyBid: vi.fn(async () => []),
  getRecentlyManuallyAdded: vi.fn(async () => []),
  getRecentlyRecommended: vi.fn(async () => []),
}));

vi.mock('~/server/services/user.service', () => ({
  getUserBookmarkedModels: vi.fn(async () => []),
}));

// The official pin is a separate Postgres path; silence it so these assertions are about the filter.
// Spread the real module — a hand-listed mock here breaks every cached object built at load time
// further down the import graph (resource-data.redis.ts among them).
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: (...args: unknown[]) => fetchThroughCache(...args),
}));

// The official pin hydrates straight from Postgres, never through Meilisearch — which is exactly why
// it needs its own filter pass, and why it cannot be observed in the `filter` string.
vi.mock('~/server/search-index/models.search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelsIndex>()),
  getModelSearchIndexRecords: (...args: unknown[]) => getModelSearchIndexRecords(...args),
}));

const { getResourceSelectModels } = await import('~/server/services/resource-select.service');

const baseInput = {
  tab: 'all' as const,
  selectSource: 'generation' as const,
  sort: 'relevance' as const,
  limit: 20,
  resources: [{ type: 'LORA' as const, baseModels: ['SDXL 1.0'] }],
  filterTypes: [],
  filterBaseModels: [],
  excludedVersionIds: [],
};

const filterOf = () => {
  expect(searchWithSignal).toHaveBeenCalledTimes(1);
  return (searchWithSignal.mock.calls[0][2] as { filter?: string }).filter ?? '';
};

describe('getResourceSelectModels — the pricing clause reaches Meilisearch', () => {
  beforeEach(() => {
    searchWithSignal.mockReset();
    searchWithSignal.mockResolvedValue({ hits: [], estimatedTotalHits: 0 });
    fetchThroughCache.mockReset();
    fetchThroughCache.mockResolvedValue([]);
    getModelSearchIndexRecords.mockReset();
    getModelSearchIndexRecords.mockResolvedValue([]);
  });

  it('emits the GenerationFree clause when hidePaid is set', async () => {
    await getResourceSelectModels({ ...baseInput, hidePaid: true }, { user: undefined });
    const filter = filterOf();
    expect(filter).toContain(`versions.pricing = ${ModelVersionPricingSignal.GenerationFree}`);
    // Without this half the gated-only backfill hides every un-rewritten document — see the clause.
    expect(filter).toContain('NOT versions.pricing EXISTS');
  });

  it('emits NO pricing clause by default — the filter is opt-in', async () => {
    await getResourceSelectModels(baseInput, { user: undefined });
    expect(filterOf()).not.toContain('versions.pricing');
  });

  it('emits no pricing clause when hidePaid is explicitly false', async () => {
    await getResourceSelectModels({ ...baseInput, hidePaid: false }, { user: undefined });
    expect(filterOf()).not.toContain('versions.pricing');
  });

  // Flattening makes a negation mean "NO version is gated", which would hide partially-paid models
  // the product keeps visible. Asserted on the emitted query, not on the builder in isolation.
  it('never negates the pricing field in a real query', async () => {
    await getResourceSelectModels({ ...baseInput, hidePaid: true }, { user: undefined });
    const filter = filterOf();
    expect(filter).not.toMatch(/NOT\s+versions\.pricing\s*=/);
    expect(filter).not.toMatch(/versions\.pricing\s*!=/);
  });
});

/**
 * 🔴 The pin is prepended from Postgres and NEVER passes through `buildFilter`, so the pricing clause
 * in the query above cannot constrain it. `officialPinActive` does not consider `hidePaid` either —
 * it stays on with the filter engaged. Without the pin's own filter pass, ticking "Hide paid" leaves a
 * paid official checkpoint as row one, with a green suite.
 *
 * The negative control matters as much as the assertion: without it, a pin that is simply broken
 * (never prepending anything) passes the hiding test.
 */
describe('getResourceSelectModels — the official pin re-applies the filter', () => {
  const pinned = (pricing: ModelVersionPricingSignal[]) => [
    {
      id: 1,
      type: 'LORA',
      versions: [{ id: 10, baseModel: 'SDXL 1.0', pricing }],
      images: [],
      tags: [],
      nsfwLevel: [1],
    },
  ];

  beforeEach(() => {
    searchWithSignal.mockReset();
    searchWithSignal.mockResolvedValue({ hits: [], estimatedTotalHits: 0 });
    fetchThroughCache.mockReset();
    fetchThroughCache.mockResolvedValue([{ id: 1, type: 'LORA' }]);
    getModelSearchIndexRecords.mockReset();
  });

  it('prepends a free official model when hidePaid is set', async () => {
    getModelSearchIndexRecords.mockResolvedValue(
      pinned([ModelVersionPricingSignal.Free, ModelVersionPricingSignal.GenerationFree])
    );
    const result = await getResourceSelectModels(
      { ...baseInput, hidePaid: true },
      { user: undefined }
    );
    expect(result.items.map((m: { id: number }) => m.id)).toContain(1);
  });

  it('DROPS a paid official model when hidePaid is set', async () => {
    getModelSearchIndexRecords.mockResolvedValue(pinned([ModelVersionPricingSignal.PayToGenerate]));
    const result = await getResourceSelectModels(
      { ...baseInput, hidePaid: true },
      { user: undefined }
    );
    expect(result.items.map((m: { id: number }) => m.id)).not.toContain(1);
  });

  // The negative control for the drop above: without the filter the same paid model still pins, so
  // the test cannot pass by the pin being broken.
  it('keeps the same paid official model when hidePaid is NOT set', async () => {
    getModelSearchIndexRecords.mockResolvedValue(pinned([ModelVersionPricingSignal.PayToGenerate]));
    const result = await getResourceSelectModels(baseInput, { user: undefined });
    expect(result.items.map((m: { id: number }) => m.id)).toContain(1);
  });
});
