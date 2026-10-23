import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MeiliClient from '~/server/meilisearch/client';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type * as ModelsIndex from '~/server/search-index/models.search-index';
import type { GetResourceSelectInput } from '~/server/schema/model.schema';

/**
 * A pasted link resolves through the same Meilisearch query as a name search, so it can only ever
 * return what searching could. These read the `filter` the client is actually handed.
 */

const searchWithSignal = vi.fn();
const getModelSearchIndexRecords = vi.fn();

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  searchClient: { index: () => ({}) },
  searchWithSignal: (...args: unknown[]) => searchWithSignal(...args),
  withMeiliResourceSelect: (fn: (signal?: AbortSignal) => unknown) => fn(undefined),
  isTransientMeiliError: () => false,
}));

vi.mock('~/server/services/model.service', () => ({
  getFeaturedModels: vi.fn(async () => []),
  getRecentlyBid: vi.fn(async () => []),
  getRecentlyManuallyAdded: vi.fn(async () => [999]),
  getRecentlyRecommended: vi.fn(async () => []),
}));

vi.mock('~/server/services/user.service', () => ({
  getUserBookmarkedModels: vi.fn(async () => []),
}));

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: vi.fn(async () => [{ id: 1, type: 'LORA' }]),
}));

vi.mock('~/server/search-index/models.search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelsIndex>()),
  getModelSearchIndexRecords: (...args: unknown[]) => getModelSearchIndexRecords(...args),
}));

const { getResourceSelectModels } = await import('~/server/services/resource-select.service');

const baseInput = {
  tab: 'all',
  selectSource: 'addResource',
  sort: 'relevance',
  limit: 50,
  resources: [{ type: 'LORA', baseModels: ['SDXL 1.0'] }],
  filterTypes: [],
  filterBaseModels: [],
  filterLoaded: false,
  filterTurbo: false,
  excludedVersionIds: [],
} satisfies GetResourceSelectInput;

// `lookup` is spread in rather than typed so this file also runs against a service that predates it.
const lookupInput = (
  lookup: { modelId?: number; modelVersionId?: number },
  overrides: Partial<GetResourceSelectInput> = {}
) => ({ ...baseInput, ...overrides, lookup } as GetResourceSelectInput);

const sentFilter = () => {
  expect(searchWithSignal).toHaveBeenCalledTimes(1);
  return (searchWithSignal.mock.calls[0][2] as { filter?: string }).filter ?? '';
};
const sentQuery = () => searchWithSignal.mock.calls[0][1] as string;

beforeEach(() => {
  searchWithSignal.mockReset();
  searchWithSignal.mockResolvedValue({ hits: [], estimatedTotalHits: 0 });
  getModelSearchIndexRecords.mockReset();
  getModelSearchIndexRecords.mockResolvedValue([]);
});

describe('resource picker lookup by pasted link', () => {
  it('asks for exactly the pasted model, with no name query', async () => {
    await getResourceSelectModels(
      lookupInput({ modelId: 123 }, { query: 'civitai.com/models/123' }),
      {
        user: undefined,
      }
    );
    expect(sentFilter()).toContain('id = 123');
    expect(sentQuery()).toBe('');
  });

  it('asks for the pasted version', async () => {
    await getResourceSelectModels(lookupInput({ modelId: 123, modelVersionId: 456 }), {
      user: undefined,
    });
    const filter = sentFilter();
    expect(filter).toContain('id = 123');
    expect(filter).toContain('versions.id = 456');
  });

  // The client explains a type or base-model mismatch; it can only do that if it gets the model back.
  it('does not apply the type / base-model scope', async () => {
    await getResourceSelectModels(
      lookupInput({ modelId: 123 }, { filterBaseModels: ['SDXL 1.0'], filterTypes: ['LORA'] }),
      { user: undefined }
    );
    const filter = sentFilter();
    expect(filter).not.toContain('versions.baseModel');
    expect(filter).not.toContain('type = ');
  });

  it('ignores the tab restriction, so a paste on Recent still finds the model', async () => {
    await getResourceSelectModels(lookupInput({ modelId: 123 }, { tab: 'recent' }), {
      user: { id: 7 },
    });
    expect(sentFilter()).not.toContain('999');
  });

  it("keeps another user's private model out for a non-owner", async () => {
    await getResourceSelectModels(lookupInput({ modelId: 123 }), { user: { id: 7 } });
    expect(sentFilter()).toContain('(availability != "Private" OR user.id = 7)');
  });

  it('keeps private models out for a signed-out viewer, with no owner exception', async () => {
    await getResourceSelectModels(lookupInput({ modelId: 123 }), { user: undefined });
    const filter = sentFilter();
    expect(filter).toContain('availability != "Private"');
    expect(filter).not.toContain('user.id');
  });

  it('keeps the celebrity exclusion', async () => {
    await getResourceSelectModels(lookupInput({ modelId: 123 }), { user: undefined });
    expect(sentFilter()).toContain('NOT tags.name = "celebrity"');
  });

  // The generator picker asks for generatable models only; a paste must not route around that.
  it('keeps the generation-coverage clause in the generator picker', async () => {
    await getResourceSelectModels(
      lookupInput({ modelId: 123 }, { selectSource: 'generation', canGenerate: true }),
      { user: undefined }
    );
    expect(sentFilter()).toMatch(/canGenerate(Next)? = true/);
  });

  it('finds a model by its version id alone', async () => {
    await getResourceSelectModels(lookupInput({ modelVersionId: 456 }), { user: undefined });
    const filter = sentFilter();
    expect(filter).toContain('versions.id = 456');
    expect(filter).not.toMatch(/(^|[ (])id = /);
  });

  it("does not narrow to the viewer's own models on the Mine tab", async () => {
    await getResourceSelectModels(lookupInput({ modelId: 123 }, { tab: 'mine' }), {
      user: { id: 7 },
    });
    expect(sentFilter()).not.toMatch(/AND user\.id = 7/);
  });

  // The auction picker shows no private model, even the bidder's own, and none that cannot be promoted.
  it('keeps the auction picker strict', async () => {
    await getResourceSelectModels(lookupInput({ modelId: 123 }, { selectSource: 'auction' }), {
      user: { id: 7 },
    });
    const filter = sentFilter();
    expect(filter).toContain('availability != "Private"');
    expect(filter).not.toContain('user.id = 7');
    expect(filter).toContain('NOT cannotPromote = true');
  });

  // An unpublished, deleted or unsearchable model is not in the index, so Meili returns nothing —
  // and nothing else may answer instead. The DB-direct record builder ignores availability.
  it('returns nothing for a model the index does not hold, without a database fallback', async () => {
    const result = await getResourceSelectModels(lookupInput({ modelId: 123 }), {
      user: undefined,
    });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
    expect(getModelSearchIndexRecords).not.toHaveBeenCalled();
  });
});
