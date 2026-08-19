import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildSearchPageUrl, parseQuery } from '~/components/AutocompleteSearch/autocomplete-query';
import { buildBrowsingLevelFilters, joinFilterClauses } from '~/components/Search/search-filters';
import { BROWSING_LEVEL_ATTRIBUTE } from '~/components/Search/search-index-filters';
import type { SearchIndexKey } from '~/components/Search/search.types';

const attribute = 'nsfwLevel' as const;
const pg = 1;

// What `AutocompleteSearch` builds for a signed-out PG user with the poi/minor addons on.
const baseFilters = ['poi != true', 'minor != true', 'availability != Private'];

function autocompleteFilters(index: SearchIndexKey, search: string, base: string[] = []) {
  const { filters } = parseQuery(index, search);

  return joinFilterClauses(
    buildBrowsingLevelFilters({
      attribute: BROWSING_LEVEL_ATTRIBUTE[index],
      browsingLevel: pg,
      filters: [...base, filters],
    })
  );
}

describe('parseQuery', () => {
  it('turns a #tag into a filter and strips it from the query', () => {
    expect(parseQuery('models', '#anime')).toEqual({
      query: ' ',
      filters: "tags.name = 'anime'",
      searchPageQuery: 'tags=anime',
    });
  });

  it('turns an @user into a filter and strips it from the query', () => {
    expect(parseQuery('models', '@civitai')).toEqual({
      query: ' ',
      filters: "user.username = 'civitai'",
      searchPageQuery: 'users=civitai',
    });
  });

  it('keeps the free text alongside the token', () => {
    expect(parseQuery('models', 'anime #style')).toEqual({
      query: 'anime',
      filters: "tags.name = 'style'",
      searchPageQuery: 'tags=style',
    });
  });

  it('returns no filters for an index without token syntax', () => {
    expect(parseQuery('tools', '#anime')).toEqual({
      query: '#anime',
      filters: '',
      searchPageQuery: '',
    });
  });
});

describe('the filters the autocomplete sends to Meilisearch', () => {
  it('ANDs a #tag onto the browsing-level clause instead of replacing it', () => {
    expect(autocompleteFilters('models', '#anime', baseFilters)).toBe(
      "(poi != true) AND (minor != true) AND (availability != Private) AND (tags.name = 'anime') AND (nsfwLevel=1)"
    );
  });

  it('ANDs an @user onto the browsing-level clause instead of replacing it', () => {
    expect(autocompleteFilters('models', '@civitai', baseFilters)).toBe(
      "(poi != true) AND (minor != true) AND (availability != Private) AND (user.username = 'civitai') AND (nsfwLevel=1)"
    );
  });

  it('keeps every clause a plain query has once a token is added', () => {
    const plain = autocompleteFilters('models', 'anime', baseFilters);
    const tagged = autocompleteFilters('models', '#anime', baseFilters);

    for (const clause of plain.split(' AND ')) expect(tagged).toContain(clause);
    expect(tagged).toContain(`(${attribute}=${pg})`);
  });

  it('emits the browsing-level clause last, so a token can never terminate the expression', () => {
    expect(autocompleteFilters('models', '#anime hash:abc123', baseFilters)).toMatch(
      /\(nsfwLevel=1\)$/
    );
  });
});

describe.each([
  ['images', 'tagNames'],
  ['articles', 'tags.name'],
] as const)('the %s index', (index, tagAttribute) => {
  it(`filters a #tag on ${tagAttribute}`, () => {
    expect(parseQuery(index, '#anime')).toEqual({
      query: ' ',
      filters: `${tagAttribute} = 'anime'`,
      searchPageQuery: 'tags=anime',
    });
  });

  it('filters an @user on user.username', () => {
    expect(parseQuery(index, '@civitai')).toEqual({
      query: ' ',
      filters: "user.username = 'civitai'",
      searchPageQuery: 'users=civitai',
    });
  });

  it('ANDs a #tag onto the browsing-level clause', () => {
    expect(autocompleteFilters(index, '#anime')).toBe(
      `(${tagAttribute} = 'anime') AND (nsfwLevel=1)`
    );
  });

  it('ANDs an @user onto the browsing-level clause', () => {
    expect(autocompleteFilters(index, '@civitai')).toBe(
      "(user.username = 'civitai') AND (nsfwLevel=1)"
    );
  });

  it('carries a #tag to the search page as a tags param', () => {
    expect(buildSearchPageUrl(index, '#anime')).toBe(`/search/${index}?tags=anime`);
  });

  it('carries an @user to the search page as a users param', () => {
    expect(buildSearchPageUrl(index, '@civitai')).toBe(`/search/${index}?users=civitai`);
  });

  it('leaves hash: alone, which only the models index can filter on', () => {
    expect(parseQuery(index, 'hash:abc123')).toEqual({
      query: 'hash:abc123',
      filters: '',
      searchPageQuery: '',
    });
  });
});

describe('the collections index', () => {
  it('filters an @user on user.username', () => {
    expect(parseQuery('collections', '@civitai')).toEqual({
      query: ' ',
      filters: "user.username = 'civitai'",
      searchPageQuery: 'users=civitai',
    });
  });

  it('ANDs an @user onto the browsing-level clause', () => {
    expect(autocompleteFilters('collections', '@civitai')).toBe(
      "(user.username = 'civitai') AND (nsfwLevel=1)"
    );
  });

  it('carries an @user to the search page as a users param', () => {
    expect(buildSearchPageUrl('collections', '@civitai')).toBe('/search/collections?users=civitai');
  });

  it('leaves a #tag in the query, having no tag attribute to filter on', () => {
    expect(parseQuery('collections', '#anime')).toEqual({
      query: '#anime',
      filters: '',
      searchPageQuery: '',
    });
  });
});

describe.each(['tools', 'users'] as const)('the %s index, which supports no tokens', (index) => {
  it('leaves every token in the query and builds no filter', () => {
    expect(parseQuery(index, '#anime @civitai')).toEqual({
      query: '#anime @civitai',
      filters: '',
      searchPageQuery: '',
    });
  });

  it('sends the whole input to the search page as a plain query', () => {
    expect(buildSearchPageUrl(index, '#anime @civitai')).toBe(
      `/search/${index}?query=%23anime%20%40civitai`
    );
  });
});

describe('buildSearchPageUrl', () => {
  it('carries a #tag as a tags param and drops the emptied query', () => {
    expect(buildSearchPageUrl('models', '#anime')).toBe('/search/models?tags=anime');
  });

  it('carries an @user as a users param', () => {
    expect(buildSearchPageUrl('models', '@civitai')).toBe('/search/models?users=civitai');
  });

  it('keeps free text and token together', () => {
    expect(buildSearchPageUrl('models', 'anime #style')).toBe(
      '/search/models?query=anime&tags=style'
    );
  });

  it('passes a plain query straight through', () => {
    expect(buildSearchPageUrl('models', 'anime')).toBe('/search/models?query=anime');
  });

  it('never emits the blank query the cleaned search would have produced', () => {
    const url = buildSearchPageUrl('models', '#anime');

    expect(url).not.toContain('query=');
    expect(url).not.toContain('%20');
  });
});

// Read as source because the unit project collects `.test.ts` only, and both bugs were wiring a
// correct function into the wrong place: a second `filters` widget silently overwrites the
// browsing-level one, and a hand-built /search URL silently drops the token params.
describe('the AutocompleteSearch InstantSearch tree', () => {
  const source = readFileSync(path.join(__dirname, '..', 'AutocompleteSearch.tsx'), 'utf-8');

  it('has exactly one widget writing `filters`', () => {
    const writers = [...source.matchAll(/<([A-Za-z]+)[^<>]*?\sfilters=\{/g)].map((m) => m[1]);

    expect(writers).toEqual(['BrowsingLevelFilter']);
  });

  it('routes every /search push through buildSearchPageUrl', () => {
    expect(source.match(/router\.push\(`\/search\/[^`]*`/g) ?? []).toEqual([]);
    expect(source).toContain('buildSearchPageUrl');
  });
});
