import { describe, expect, it } from 'vitest';
import { buildFilter } from '~/server/services/resource-select.service';
import type { GetResourceSelectInput } from '~/server/schema/model.schema';

const input = (overrides: Partial<GetResourceSelectInput> = {}): GetResourceSelectInput => ({
  tab: 'all',
  selectSource: 'generation',
  sort: 'relevance',
  limit: 20,
  resources: [{ type: 'LORA', baseModels: ['MOSS Image'] }],
  filterTypes: [],
  filterBaseModels: [],
  filterLoaded: false,
  filterTurbo: false,
  excludedVersionIds: [],
  ...overrides,
});

const filterFor = (overrides?: Partial<GetResourceSelectInput>) =>
  buildFilter({
    input: input(overrides),
    user: { id: 1, isModerator: false },
    tabIds: null,
    coverageNext: true,
    member: true,
  }) ?? '';

describe('the picker’s turbo-only filter', () => {
  it('asks Meilisearch for turbo versions only when it is on', () => {
    expect(filterFor({ filterTurbo: true })).toContain('versions.turbo = true');
  });

  it('asks for nothing of the kind when it is off', () => {
    expect(filterFor()).not.toContain('versions.turbo');
  });

  // Off the filterable list, Meili rejects the whole search and the picker shows nothing at all.
  it('filters on an attribute the index is told to make filterable', async () => {
    const { modelsFilterableAttributes } = await import(
      '~/server/search-index/filterable-attributes'
    );
    expect(modelsFilterableAttributes).toContain('versions.turbo');
  });
});
