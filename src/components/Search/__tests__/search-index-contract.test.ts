import { describe, expect, it } from 'vitest';
import { queryFilters } from '~/components/AutocompleteSearch/autocomplete-query';
import { ArticlesSearchIndexSortBy } from '~/components/Search/parsers/article.parser';
import { BountiesSearchIndexSortBy } from '~/components/Search/parsers/bounties.parser';
import { CollectionsSearchIndexSortBy } from '~/components/Search/parsers/collection.parser';
import { ComicsSearchIndexSortBy } from '~/components/Search/parsers/comic.parser';
import { ImagesSearchIndexSortBy } from '~/components/Search/parsers/image.parser';
import { ModelSearchIndexSortBy } from '~/components/Search/parsers/model.parser';
import { ToolsSearchIndexSortBy } from '~/components/Search/parsers/tool.parser';
import { UsersSearchIndexSortBy } from '~/components/Search/parsers/user.parser';
import { BROWSING_LEVEL_ATTRIBUTE } from '~/components/Search/search-index-filters';
import { buildBrowsingLevelClause } from '~/components/Search/search-filters';
import type { SearchIndexKey } from '~/components/Search/search.types';
import { searchIndexMap } from '~/components/Search/search.types';
import { filterableAttributesByIndex } from '~/server/search-index/filterable-attributes';
import {
  bountiesSortableAttributes,
  modelsSortableAttributes,
  sortableAttributesByIndex,
} from '~/server/search-index/sortable-attributes';

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

describe('search sort options', () => {
  // Every `sortBy` an InstantSearch results page can put on the URL, keyed by the index it is
  // sent to. A value is either the bare index name (relevancy, no sort) or
  // `<index>:<attribute>[:<direction>]`.
  const sortOptionsByIndex: Record<string, readonly string[]> = {
    [searchIndexMap.articles]: ArticlesSearchIndexSortBy,
    [searchIndexMap.bounties]: BountiesSearchIndexSortBy,
    [searchIndexMap.collections]: CollectionsSearchIndexSortBy,
    [searchIndexMap.comics]: ComicsSearchIndexSortBy,
    [searchIndexMap.images]: ImagesSearchIndexSortBy,
    [searchIndexMap.models]: ModelSearchIndexSortBy,
    [searchIndexMap.tools]: ToolsSearchIndexSortBy,
    [searchIndexMap.users]: UsersSearchIndexSortBy,
  };

  const sortedAttributes = Object.entries(sortOptionsByIndex).flatMap(([indexName, options]) =>
    options
      // An attribute never contains `:`, so index 1 is the whole attribute path.
      .map((option) => option.split(':')[1])
      .filter((attribute): attribute is string => Boolean(attribute))
      .map((attribute) => [indexName, attribute] as [string, string])
  );

  it('covers a sort option from every index', () => {
    expect(Object.keys(sortOptionsByIndex).sort()).toEqual(
      Object.values(searchIndexMap).slice().sort()
    );
    expect(sortedAttributes.length).toBeGreaterThan(0);
  });

  it.each(sortedAttributes)(
    '%s sorts on %s, which that index declares sortable',
    (indexName, attribute) => {
      expect(
        sortableAttributesByIndex[indexName as keyof typeof sortableAttributesByIndex],
        `a sort option sends \`${indexName}:${attribute}\`, but ${indexName} does not declare ${attribute} sortable — Meilisearch answers \`Attribute \`${attribute}\` is not sortable\` and the whole results page fails`
      ).toContain(attribute);
    }
  );
});

describe('the models index sort contract', () => {
  // Literal, and read back from the live search index rather than derived from the code under
  // test. `sortableAttributes` only ever reach a live index through `onIndexSetup`, which runs solely
  // inside the manual (`UNRUNNABLE_JOB_CRON`) index-reset job — so renaming an attribute here and
  // pointing the client at the new name in the same release leaves the client asking for something
  // the live index has never heard of, and every sorted model search 400s until someone runs a
  // reset. Update these two lists only together with a reset that has actually shipped.
  // 🔴 ONE ENTRY IN THE LIST BELOW IS NOT YET PROVISIONED ON THE LIVE INDEX, so this assertion is
  // no longer purely a read-back of it. `insight.qualityScore` was added ahead of the reset that
  // provisions it — which the sibling comment above permits for an ADDITION ("takes effect
  // whenever a reset next happens") but which leaves a real window: until
  // `search-index-sync-models-reset` has run, the live `models_v9` has never heard of this
  // attribute, so ANY client that sorts on it gets `Attribute ... is not sortable` and the query
  // 400s.
  //
  // Today exactly one client sorts on it — `searchShortlistModels` in
  // ~/server/services/resource-intent-matcher.service.ts — and it is unreachable in production
  // while the resource-intent Flipt flag is off. That flag is the ONLY thing closing this window.
  // 🔴 So: do not enable that flag until the reset has shipped. Flipping it first turns every
  // shortlist query into a 400.
  //
  // ⚠ It is not the only attribute waiting on that reset: `sortMetrics` is in the same state for a
  // different reason, recorded at src/components/Search/parsers/model.parser.ts:21-24 (declared
  // nowhere yet, so the client still sorts on `metrics.*`). An earlier version of this comment
  // claimed "nothing else in either repo records this", which was wrong.
  //
  // ⚠ There is deliberately NO machine-readable pending-set here. One was tried and removed in the
  // same PR that added it: every assertion it could make was either already made by the
  // whole-list `toEqual` below (deleting the attribute fails that), or vacuous once the set was
  // emptied (`[].every(...)` is `true`). Nothing in this repo can observe whether the reset has
  // actually run, so no guard at this level can distinguish "provisioned" from "still pending" —
  // which is precisely what such a set would have to read to be worth anything.
  it('declares exactly the sortable attributes the models index is provisioned with', () => {
    expect(modelsSortableAttributes.slice().sort()).toEqual([
      'createdAt',
      'id',
      // 🔴 NOT YET PROVISIONED ON THE LIVE INDEX — see the comment above.
      'insight.qualityScore',
      'metrics.collectedCount',
      'metrics.commentCount',
      'metrics.downloadCount',
      'metrics.favoriteCount',
      'metrics.thumbsUpCount',
      'metrics.tippedAmountCount',
    ]);
  });

  it('offers exactly the sort options those attributes support, in label order', () => {
    // Order is load-bearing: src/pages/search/models.tsx maps its dropdown labels
    // ("Relevancy", "Highest Rated", "Most Downloaded", …) onto these by position.
    expect(ModelSearchIndexSortBy.slice()).toEqual([
      'models_v9',
      'models_v9:metrics.thumbsUpCount:desc',
      'models_v9:metrics.downloadCount:desc',
      'models_v9:metrics.favoriteCount:desc',
      'models_v9:metrics.commentCount:desc',
      'models_v9:metrics.collectedCount:desc',
      'models_v9:metrics.tippedAmountCount:desc',
      'models_v9:createdAt:desc',
    ]);
  });
});

describe('the bounties index sort contract', () => {
  // Literal, and verified against the live search index rather than inferred. A bounty document
  // carries its counts only under `stats`, so a bare `favoriteCountAllTime` names a field no
  // document has: declaring it sortable would not surface an error, it would let Meilisearch
  // accept the sort and answer in an arbitrary order — a silent wrong answer where the prefixed
  // spelling gives a correct one.
  it('declares exactly the sortable attributes the live bounties index is provisioned with', () => {
    expect(bountiesSortableAttributes.slice().sort()).toEqual([
      'createdAt',
      'id',
      'stats.entryCountAllTime',
      'stats.favoriteCountAllTime',
      'stats.unitAmountCountAllTime',
    ]);
  });

  it('offers exactly the sort options those attributes support, in label order', () => {
    // Order is load-bearing: src/pages/search/bounties.tsx maps its dropdown labels
    // ("Relevancy", "Most Buzz", "Entry Count", "Favorite", "Newest") onto these by position.
    expect(BountiesSearchIndexSortBy.slice()).toEqual([
      'bounties_v3',
      'bounties_v3:stats.unitAmountCountAllTime:desc',
      'bounties_v3:stats.entryCountAllTime:desc',
      'bounties_v3:stats.favoriteCountAllTime:desc',
      'bounties_v3:createdAt',
    ]);
  });
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
