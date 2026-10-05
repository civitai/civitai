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

const filterFor = (
  overrides?: Partial<GetResourceSelectInput>,
  coverageNext = true,
  member = true
) =>
  buildFilter({
    input: input(overrides),
    user: { id: 1, isModerator: false },
    tabIds: null,
    coverageNext,
    member,
  }) ?? '';

describe('the picker’s loaded-only filter', () => {
  it('asks Meilisearch for resident versions only when it is on', () => {
    expect(filterFor({ filterLoaded: true })).toContain('versions.generatorLoaded = true');
  });

  it('asks for nothing of the kind when it is off', () => {
    expect(filterFor()).not.toContain('generatorLoaded');
  });

  // The picker must gate on the same rule the generation path does, or it offers what the submit refuses.
  it('gates on the staged rule when that is the live one', () => {
    const filter = filterFor({ canGenerate: true }, true);
    expect(filter).toContain('canGenerateNext = true');
    expect(filter).not.toContain('canGenerate = true');
  });

  /**
   * A non-member keeps the live set plus anything already resident, so both fields appear. The
   * `canGenerate = true` half is what stops the expansion gate hiding an auction winner from them.
   */
  it('keeps the live set and resident versions for a non-member', () => {
    const filter = filterFor({ canGenerate: true }, true, false);
    expect(filter).toContain('canGenerate = true');
    expect(filter).toContain('canGenerateNext = true');
    expect(filter).toContain('versions.generatorLoaded = true');
  });

  it('does not widen for a non-member while the expansion is off', () => {
    const filter = filterFor({ canGenerate: true }, false, false);
    expect(filter).toContain('canGenerate = true');
    expect(filter).not.toContain('canGenerateNext');
    expect(filter).not.toContain('generatorLoaded');
  });

  it('gates on the live rule when the flag is off', () => {
    const filter = filterFor({ canGenerate: true }, false);
    expect(filter).toContain('canGenerate = true');
    expect(filter).not.toContain('canGenerateNext = true');
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
