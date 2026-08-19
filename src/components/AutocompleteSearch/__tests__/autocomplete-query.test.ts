import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildSearchPageUrl, parseQuery } from '~/components/AutocompleteSearch/autocomplete-query';
import { buildBrowsingLevelFilters, joinFilterClauses } from '~/components/Search/search-filters';

const attribute = 'nsfwLevel' as const;
const pg = 1;

// What `AutocompleteSearch` builds for a signed-out PG user with the poi/minor addons on.
const baseFilters = ['poi != true', 'minor != true', 'availability != Private'];

function autocompleteFilters(search: string) {
  const { filters } = parseQuery('models', search);

  return joinFilterClauses(
    buildBrowsingLevelFilters({
      attribute,
      browsingLevel: pg,
      filters: [...baseFilters, filters],
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
    expect(parseQuery('images', '#anime')).toEqual({
      query: '#anime',
      filters: '',
      searchPageQuery: '',
    });
  });
});

describe('the filters the autocomplete sends to Meilisearch', () => {
  it('ANDs a #tag onto the browsing-level clause instead of replacing it', () => {
    expect(autocompleteFilters('#anime')).toBe(
      "(poi != true) AND (minor != true) AND (availability != Private) AND (tags.name = 'anime') AND (nsfwLevel=1)"
    );
  });

  it('ANDs an @user onto the browsing-level clause instead of replacing it', () => {
    expect(autocompleteFilters('@civitai')).toBe(
      "(poi != true) AND (minor != true) AND (availability != Private) AND (user.username = 'civitai') AND (nsfwLevel=1)"
    );
  });

  it('keeps every clause a plain query has once a token is added', () => {
    const plain = autocompleteFilters('anime');
    const tagged = autocompleteFilters('#anime');

    for (const clause of plain.split(' AND ')) expect(tagged).toContain(clause);
    expect(tagged).toContain(`(${attribute}=${pg})`);
  });

  it('emits the browsing-level clause last, so a token can never terminate the expression', () => {
    expect(autocompleteFilters('#anime hash:abc123')).toMatch(/\(nsfwLevel=1\)$/);
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
