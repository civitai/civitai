import { describe, expect, test } from 'vitest';
import {
  APPS_STORE_DEFAULTS,
  appsStoreFiltersToQuery,
  countActiveAppsStoreFilters,
  hasActiveAppsStoreFilters,
  parseAppsStoreFilters,
  resolveAppsStoreFilters,
} from '~/components/Apps/appsStoreQueryParams';

/**
 * `/apps` store URL-state pins (blocking `unit` project).
 *
 * The browser-mode suite covers the wiring (does the dropdown write the param,
 * does a seeded mount drive the query); this covers the DECISIONS — what an
 * invalid param does, what reaches the URL, and what the badge counts. CI does
 * not run the browser project, so these are the ones that actually gate a PR.
 */

describe('parseAppsStoreFilters — a bare /apps', () => {
  test('no params → the documented defaults', () => {
    expect(parseAppsStoreFilters({})).toEqual({
      kind: 'all',
      category: null,
      sort: 'top-rated',
      query: '',
    });
    expect(parseAppsStoreFilters({})).toEqual(APPS_STORE_DEFAULTS);
  });

  test('a fully-specified URL round-trips', () => {
    expect(
      parseAppsStoreFilters({
        kind: 'offsite',
        category: 'generation',
        sort: 'newest',
        query: 'matrix',
      })
    ).toEqual({ kind: 'offsite', category: 'generation', sort: 'newest', query: 'matrix' });
  });

  test('unrelated params (utm_*, ref) are ignored, not fatal', () => {
    const filters = parseAppsStoreFilters({ kind: 'onsite', utm_source: 'discord', ref: 'x' });
    expect(filters.kind).toBe('onsite');
  });
});

/**
 * 🔴 THE DEGRADATION CONTRACT. "Invalid/unknown param values must degrade to the
 * default, never throw or render an empty grid." Every case below would, under a
 * single whole-object `safeParse` (the `useModelQueryParams` shape), throw away
 * the VALID sibling fields too.
 */
describe('parseAppsStoreFilters — invalid input degrades per FIELD', () => {
  test('an unknown enum value falls back to that field only', () => {
    const filters = parseAppsStoreFilters({ kind: 'sideways', sort: 'newest' });
    expect(filters.kind).toBe('all'); // degraded
    expect(filters.sort).toBe('newest'); // 🔴 the valid sibling SURVIVES
  });

  test('an unknown category falls back to null (no empty grid, no error state)', () => {
    expect(parseAppsStoreFilters({ category: 'hats' }).category).toBeNull();
  });

  test('a repeated param (Next parses ?kind=a&kind=b into an array) degrades', () => {
    expect(parseAppsStoreFilters({ kind: ['onsite', 'offsite'] }).kind).toBe('all');
    expect(parseAppsStoreFilters({ query: ['a', 'b'] }).query).toBe('');
  });

  test('every junk shape is TOTAL — never throws', () => {
    for (const input of [
      undefined,
      null,
      'not-an-object',
      42,
      [],
      { kind: null },
      { kind: 0 },
      { category: {} },
      { sort: false },
      { query: 123 },
      { kind: 'onsite', category: 'nope', sort: 'nope', query: [] },
    ]) {
      expect(() => parseAppsStoreFilters(input)).not.toThrow();
      const out = parseAppsStoreFilters(input);
      // Always a COMPLETE, valid state — the grid always has something to render.
      expect(Object.keys(out).sort()).toEqual(['category', 'kind', 'query', 'sort']);
      expect(['all', 'onsite', 'offsite']).toContain(out.kind);
      expect(['top-rated', 'popular', 'newest', 'name']).toContain(out.sort);
      expect(typeof out.query).toBe('string');
    }
  });

  test('a whitespace-only ?query= is treated as no search', () => {
    expect(parseAppsStoreFilters({ query: '   ' }).query).toBe('');
  });
});

describe('resolveAppsStoreFilters — pure and deterministic', () => {
  test('same input → same output (no clock, no window, no randomness)', () => {
    const input = { kind: 'onsite' as const, sort: 'name' as const };
    expect(resolveAppsStoreFilters(input)).toEqual(resolveAppsStoreFilters(input));
  });
});

describe('appsStoreFiltersToQuery — only NON-default filters reach the URL', () => {
  test('a default value serialises to undefined so removeEmpty strips it', () => {
    expect(appsStoreFiltersToQuery({ kind: 'all' })).toEqual({ kind: undefined });
    expect(appsStoreFiltersToQuery({ sort: 'top-rated' })).toEqual({ sort: undefined });
    expect(appsStoreFiltersToQuery({ category: null })).toEqual({ category: undefined });
    expect(appsStoreFiltersToQuery({ query: '' })).toEqual({ query: undefined });
    expect(appsStoreFiltersToQuery({ query: '  ' })).toEqual({ query: undefined });
  });

  test('a non-default value is written through', () => {
    expect(appsStoreFiltersToQuery({ kind: 'offsite' })).toEqual({ kind: 'offsite' });
    expect(appsStoreFiltersToQuery({ category: 'games' })).toEqual({ category: 'games' });
    expect(appsStoreFiltersToQuery({ sort: 'newest' })).toEqual({ sort: 'newest' });
    expect(appsStoreFiltersToQuery({ query: 'gen' })).toEqual({ query: 'gen' });
  });

  test('an OMITTED key stays omitted (a patch, not a full overwrite)', () => {
    // `useZodRouteParams` merges the patch over the live query, so emitting a key
    // the caller did not pass would silently clear an unrelated filter.
    expect(appsStoreFiltersToQuery({ kind: 'onsite' })).not.toHaveProperty('sort');
    expect(appsStoreFiltersToQuery({})).toEqual({});
  });

  test('the Clear-all patch clears exactly kind + category', () => {
    expect(appsStoreFiltersToQuery({ kind: 'all', category: null })).toEqual({
      kind: undefined,
      category: undefined,
    });
  });
});

describe('countActiveAppsStoreFilters — the Indicator badge', () => {
  test('0 / 1 / 2 — and NEVER counts search or sort', () => {
    expect(countActiveAppsStoreFilters({ kind: 'all', category: null })).toBe(0);
    expect(countActiveAppsStoreFilters({ kind: 'onsite', category: null })).toBe(1);
    expect(countActiveAppsStoreFilters({ kind: 'all', category: 'games' })).toBe(1);
    expect(countActiveAppsStoreFilters({ kind: 'offsite', category: 'utility' })).toBe(2);
  });

  test('caps at 2 — the panel holds exactly two controls', () => {
    for (const kind of ['all', 'onsite', 'offsite'] as const)
      for (const category of [null, 'games'] as const)
        expect(countActiveAppsStoreFilters({ kind, category })).toBeLessThanOrEqual(2);
  });
});

describe('hasActiveAppsStoreFilters — the empty state, DELIBERATELY broader', () => {
  test('search alone offers "Clear filters" even though the badge shows nothing', () => {
    const filters = { kind: 'all' as const, category: null, query: 'zzz' };
    expect(countActiveAppsStoreFilters(filters)).toBe(0); // badge: no dropdown filters
    expect(hasActiveAppsStoreFilters(filters)).toBe(true); // empty state: still offer a reset
  });

  test('nothing active → no reset affordance', () => {
    expect(hasActiveAppsStoreFilters({ kind: 'all', category: null, query: '' })).toBe(false);
    expect(hasActiveAppsStoreFilters({ kind: 'all', category: null, query: '   ' })).toBe(false);
  });

  test('a dropdown filter alone is enough', () => {
    expect(hasActiveAppsStoreFilters({ kind: 'offsite', category: null, query: '' })).toBe(true);
    expect(hasActiveAppsStoreFilters({ kind: 'all', category: 'other', query: '' })).toBe(true);
  });
});
