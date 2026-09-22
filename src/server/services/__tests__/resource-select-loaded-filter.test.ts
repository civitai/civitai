import { describe, expect, it } from 'vitest';
import { buildFilter } from '~/server/services/resource-select.service';
import type { GetResourceSelectInput } from '~/server/schema/model.schema';

const input = (overrides: Partial<GetResourceSelectInput> = {}): GetResourceSelectInput => ({
  tab: 'all',
  selectSource: 'generation',
  sort: 'relevance',
  limit: 20,
  resources: [{ type: 'Checkpoint', baseModels: [] }],
  filterTypes: [],
  filterBaseModels: [],
  filterLoaded: false,
  excludedVersionIds: [],
  ...overrides,
});

const filterFor = (overrides?: Partial<GetResourceSelectInput>) =>
  buildFilter({ input: input(overrides), user: { id: 1, isModerator: false }, tabIds: null }) ?? '';

describe('the picker’s loaded-only filter', () => {
  it('asks Meilisearch for resident versions only when it is on', () => {
    expect(filterFor({ filterLoaded: true })).toContain('versions.generatorLoaded = true');
  });

  it('asks for nothing of the kind when it is off', () => {
    expect(filterFor()).not.toContain('generatorLoaded');
  });

  it('gates coverage on the staged rule, not the live one', () => {
    const filter = filterFor({ canGenerate: true });
    expect(filter).toContain('canGenerateNext = true');
    expect(filter).not.toContain('canGenerate = true');
  });

  // `versions.generatorLoaded` has to be in `modelsFilterableAttributes` AND applied to the live
  // index, or Meili rejects the whole search and the picker returns nothing at all.
  it('filters on an attribute the index is told to make filterable', async () => {
    const { modelsFilterableAttributes } = await import(
      '~/server/search-index/filterable-attributes'
    );
    expect(modelsFilterableAttributes).toContain('versions.generatorLoaded');
  });
});
