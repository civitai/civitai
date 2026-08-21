import { describe, expect, it } from 'vitest';
import { queryFilters } from '~/components/AutocompleteSearch/autocomplete-query';
import { BROWSING_LEVEL_ATTRIBUTE } from '~/components/Search/search-index-filters';
import { buildBrowsingLevelClause } from '~/components/Search/search-filters';
import type { SearchIndexKey } from '~/components/Search/search.types';
import { searchIndexMap } from '~/components/Search/search.types';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { filterableAttributesByIndex } from '~/server/search-index/filterable-attributes';

const searchIndexKeys = Object.keys(searchIndexMap) as SearchIndexKey[];

describe('BROWSING_LEVEL_ATTRIBUTE', () => {
  it.each(Object.entries(BROWSING_LEVEL_ATTRIBUTE) as [SearchIndexKey, string][])(
    '"%s" filters on an attribute its index actually declares',
    (key, attribute) => {
      const indexName = searchIndexMap[key];
      const filterable = filterableAttributesByIndex[indexName];

      expect(
        filterable,
        `"${key}" search filters on ${attribute}, but ${indexName} does not declare it filterable — Meilisearch answers 400 invalid_search_filter and the whole search fails`
      ).toContain(attribute);
    }
  );

  it('covers every index that can filter on a browsing level', () => {
    const unmapped = searchIndexKeys.filter(
      (key) =>
        filterableAttributesByIndex[searchIndexMap[key]].includes('nsfwLevel') &&
        !BROWSING_LEVEL_ATTRIBUTE[key]
    );

    expect(unmapped).toEqual([]);
  });

  it('the images override attribute is filterable', () => {
    expect(filterableAttributesByIndex[IMAGES_SEARCH_INDEX]).toContain('combinedNsfwLevel');
  });
});

describe('queryFilters', () => {
  const tokenAttributes = Object.entries(queryFilters).flatMap(([key, config]) =>
    Object.keys(config?.filters ?? {}).map(
      (attribute) => [key, attribute] as [SearchIndexKey, string]
    )
  );

  it.each(tokenAttributes)(
    '"%s" builds its %s token filter on an attribute its index actually declares',
    (key, attribute) => {
      const indexName = searchIndexMap[key];

      expect(
        filterableAttributesByIndex[indexName],
        `"${key}" autocomplete turns a search token into \`${attribute} = ...\`, but ${indexName} does not declare ${attribute} filterable — Meilisearch answers 400 invalid_search_filter and the dropdown goes empty`
      ).toContain(attribute);
    }
  );
});

describe('filterableAttributesByIndex', () => {
  // Meilisearch dedupes on write, so a repeated entry leaves onIndexSetup's
  // declared-vs-stored check unsatisfiable — it re-sends the settings on every run and
  // the stored value can never match what it is compared against.
  it.each(Object.entries(filterableAttributesByIndex))(
    '%s declares each attribute once',
    (indexName, attributes) => {
      const duplicates = attributes.filter((a, i) => attributes.indexOf(a) !== i);

      expect(duplicates, `${indexName} repeats ${duplicates.join(', ')}`).toEqual([]);
    }
  );
});

describe('an index with no browsing-level attribute', () => {
  it('contributes no clause, so nothing unfilterable reaches Meilisearch', () => {
    expect(buildBrowsingLevelClause(BROWSING_LEVEL_ATTRIBUTE.tools, 5)).toBeNull();
    expect(buildBrowsingLevelClause(BROWSING_LEVEL_ATTRIBUTE.users, 5)).toBeNull();
  });

  it('still builds a clause for a mapped index', () => {
    expect(buildBrowsingLevelClause(BROWSING_LEVEL_ATTRIBUTE.models, 1 | 2)).toBe(
      'nsfwLevel=1 OR nsfwLevel=2'
    );
  });
});
