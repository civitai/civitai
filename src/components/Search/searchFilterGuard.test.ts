import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEILI_QUERY_ERROR_TYPE } from '~/components/Search/resilientSearchClient';
import {
  collectFilterAttributes,
  findUnsupportedFilterAttributes,
  SEARCH_FILTER_GUARD_ERROR_TYPE,
  unsupportedAttributes,
  withSearchFilterGuard,
} from '~/components/Search/searchFilterGuard';
import {
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
} from '~/server/common/constants';

// The SDK's `faro` export is a bare `{}` until `initializeFaro` runs, which never happens
// in test — so the reporting path has to be driven by standing an `api` on it.
const { faro } = vi.hoisted(() => ({ faro: {} as Record<string, unknown> }));
vi.mock('@grafana/faro-web-sdk', () => ({ faro }));

const pushError = vi.fn();
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  pushError.mockClear();
  for (const key of Object.keys(faro)) delete faro[key];
  Object.assign(faro, { api: { pushError } });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => consoleError.mockRestore());

/**
 * The exact filter set `AutocompleteSearch` builds while its target is `models`. Measured in
 * production landing on four other indexes after a target switch. `4711` is a user id that
 * cannot collide with anything the guard looks at — the guard never reads values.
 */
const MODELS_FILTER_SET = [
  `(poi != true OR user.id = 4711)`,
  `(minor != true)`,
  `(availability != Private OR user.id = 4711)`,
].join(' AND ');

/** What the same component builds once its target really is `images`. */
const IMAGES_FILTER_SET = [
  `(poi != true OR user.username = 'someone')`,
  `(minor != true)`,
  `(nsfwLevel=1 OR nsfwLevel=2)`,
].join(' AND ');

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    search: vi.fn(),
    searchForFacetValues: vi.fn(),
    clearCache: vi.fn(),
    ...overrides,
  } as any;
}

const okResponse = (count: number) => ({
  results: Array.from({ length: count }, (_, i) => ({
    hits: [{ id: 100 + i }],
    nbHits: 1,
    nbPages: 1,
    page: 0,
    hitsPerPage: 1,
    processingTimeMS: 3,
    query: 'cat',
    params: '',
  })),
});

describe('collectFilterAttributes', () => {
  it('reads the attribute out of every comparison form', () => {
    expect(
      collectFilterAttributes({
        filters: `a = 1 AND b != 2 AND c > 3 AND d >= 4 AND e < 5 AND f <= 6`,
      }).sort()
    ).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('reads the keyword and range forms too', () => {
    expect(
      collectFilterAttributes({
        filters: `g IN [1, 2] AND h NOT IN [3] AND i EXISTS AND j IS EMPTY AND k 1 TO 10`,
      }).sort()
    ).toEqual(['g', 'h', 'i', 'j', 'k']);
  });

  it('does not mistake grammar words or a NOT prefix for an attribute', () => {
    expect(collectFilterAttributes({ filters: `NOT tags.name = 'cat'` })).toEqual(['tags.name']);
  });

  it('drops a grammar word that lands in attribute position in a malformed expression', () => {
    // Reachable, not defensive: in each of these a keyword really does sit where an attribute
    // sits, and without the reserved-word filter it would be reported as an unfilterable
    // attribute of its own — a local rejection of a query for a reason that is not true.
    expect(collectFilterAttributes({ filters: `NOT tagNames = 1 AND NOT EXISTS` })).toEqual([
      'tagNames',
    ]);
    expect(collectFilterAttributes({ filters: `a = 1 AND NOT IN [2]` })).toEqual(['a']);
  });

  it('does not read inside a quoted value', () => {
    // A username is free text and can contain anything a filter expression can.
    expect(
      collectFilterAttributes({ filters: `user.username = 'sneaky = value AND other EXISTS'` })
    ).toEqual(['user.username']);
  });

  it('covers facetFilters, facets and numericFilters', () => {
    expect(
      collectFilterAttributes({
        facetFilters: [['type:Checkpoint'], 'category.name:anime'],
        facets: ['tags.name', '*'],
        numericFilters: ['versions.id >= 12345'],
      }).sort()
    ).toEqual(['category.name', 'tags.name', 'type', 'versions.id']);
  });

  it('returns nothing for params with no filters at all', () => {
    expect(collectFilterAttributes({ query: 'cat', hitsPerPage: 6 })).toEqual([]);
    expect(collectFilterAttributes(undefined)).toEqual([]);
  });

  it('never yields an empty attribute name from malformed input', () => {
    // No index declares `''`, so letting one through would reject the whole request — this
    // guard must fail open on garbage, never closed.
    expect(collectFilterAttributes({ facetFilters: [':orphaned-value'] })).toEqual([]);
    expect(collectFilterAttributes({ facets: [''] })).toEqual([]);
  });
});

describe('unsupportedAttributes', () => {
  it('lets a declared parent cover its sub-fields, on the dot and not on the prefix', () => {
    expect(unsupportedAttributes(['user'], { filters: `user.id = 4711` })).toEqual([]);
    // `username` is a different attribute that merely starts with the same letters.
    expect(unsupportedAttributes(['user'], { filters: `username = 'someone'` })).toEqual([
      'username',
    ]);
  });
});

describe('findUnsupportedFilterAttributes', () => {
  it('names exactly the models-only attributes when that filter set lands on images', () => {
    // The production signature: `images_v6` rejecting `user.id` and `availability`, while
    // `poi` and `minor` — which images DOES declare — are not flagged.
    expect(
      findUnsupportedFilterAttributes(IMAGES_SEARCH_INDEX, { filters: MODELS_FILTER_SET }).sort()
    ).toEqual(['availability', 'user.id']);
  });

  it('flags poi on an index that never intends it', () => {
    expect(
      findUnsupportedFilterAttributes(COLLECTIONS_SEARCH_INDEX, {
        filters: MODELS_FILTER_SET,
      }).sort()
    ).toEqual(['availability', 'minor', 'poi', 'user.id']);
    expect(
      findUnsupportedFilterAttributes(COMICS_SEARCH_INDEX, { filters: `poi != true` })
    ).toEqual(['poi']);
  });

  it('POSITIVE CONTROL: a filter set built for the index it is sent to is not flagged', () => {
    expect(
      findUnsupportedFilterAttributes(IMAGES_SEARCH_INDEX, { filters: IMAGES_FILTER_SET })
    ).toEqual([]);
    expect(
      findUnsupportedFilterAttributes(MODELS_SEARCH_INDEX, { filters: MODELS_FILTER_SET })
    ).toEqual([]);
  });

  it('fails open on an index it holds no declaration for', () => {
    expect(
      findUnsupportedFilterAttributes('some_other_index_v1', { filters: MODELS_FILTER_SET })
    ).toEqual([]);
    expect(findUnsupportedFilterAttributes(undefined, { filters: MODELS_FILTER_SET })).toEqual([]);
  });
});

describe('withSearchFilterGuard', () => {
  it('does not send a doomed request, and answers the empty-result shape', async () => {
    const base = makeClient({ search: vi.fn().mockResolvedValue(okResponse(1)) });
    const client = withSearchFilterGuard(base);

    const response = (await client.search([
      { indexName: IMAGES_SEARCH_INDEX, params: { query: 'cat', filters: MODELS_FILTER_SET } },
    ] as any)) as any;

    expect(base.search).not.toHaveBeenCalled();
    expect(response.results).toHaveLength(1);
    expect(response.results[0].hits).toEqual([]);
    expect(response.results[0].nbHits).toBe(0);
  });

  it('POSITIVE CONTROL: a legitimate same-index query reaches the base client untouched', async () => {
    const passthrough = okResponse(1);
    const base = makeClient({ search: vi.fn().mockResolvedValue(passthrough) });
    const client = withSearchFilterGuard(base);

    const requests = [
      { indexName: IMAGES_SEARCH_INDEX, params: { query: 'cat', filters: IMAGES_FILTER_SET } },
    ] as any;
    const response = await client.search(requests);

    expect(base.search).toHaveBeenCalledTimes(1);
    expect(base.search).toHaveBeenCalledWith(requests);
    expect(response).toBe(passthrough);
    expect(pushError).not.toHaveBeenCalled();
  });

  it('beacons a rejection under its OWN type, carrying the index and attributes', async () => {
    const client = withSearchFilterGuard(makeClient());

    await client.search([
      { indexName: COLLECTIONS_SEARCH_INDEX, params: { query: 'cat', filters: `poi != true` } },
    ] as any);

    expect(pushError).toHaveBeenCalledTimes(1);
    const [error, payload] = pushError.mock.calls[0] as [Error, any];
    expect(error).toBeInstanceOf(Error);
    expect(payload.type).toBe(SEARCH_FILTER_GUARD_ERROR_TYPE);
    expect(payload.context.indexes).toBe(COLLECTIONS_SEARCH_INDEX);
    expect(payload.context.attributes).toBe('poi');
    expect(consoleError).toHaveBeenCalled();
  });

  // INVARIANT GUARD, not regression coverage: the bug never merged the two error types. It is
  // here because the operator's condition for this change was that a locally-rejected request
  // stay tellable apart from a backend-rejected one.
  it('INVARIANT: is distinguishable from a rejection the backend issued', () => {
    expect(SEARCH_FILTER_GUARD_ERROR_TYPE).not.toBe(MEILI_QUERY_ERROR_TYPE);
  });

  // INVARIANT GUARD, not regression coverage: no revision ever beaconed the query.
  it('INVARIANT: never beacons the user query', async () => {
    const client = withSearchFilterGuard(makeClient());
    await client.search([
      {
        indexName: COLLECTIONS_SEARCH_INDEX,
        params: { query: 'a-very-private-search', filters: `poi != true` },
      },
    ] as any);

    const serialized = JSON.stringify(pushError.mock.calls) + String(pushError.mock.calls[0][0]);
    expect(serialized).not.toContain('a-very-private-search');
  });

  it('rejects only the doomed request in a batch and keeps the valid one in place', async () => {
    const base = makeClient({
      search: vi.fn().mockResolvedValue({
        results: [
          {
            hits: [{ id: 77 }],
            nbHits: 1,
            nbPages: 1,
            page: 0,
            hitsPerPage: 1,
            processingTimeMS: 1,
            query: 'cat',
            params: '',
          },
        ],
      }),
    });
    const client = withSearchFilterGuard(base);

    const response = (await client.search([
      { indexName: IMAGES_SEARCH_INDEX, params: { query: 'cat', filters: MODELS_FILTER_SET } },
      { indexName: MODELS_SEARCH_INDEX, params: { query: 'cat', filters: MODELS_FILTER_SET } },
    ] as any)) as any;

    expect(base.search).toHaveBeenCalledTimes(1);
    expect(base.search.mock.calls[0][0]).toHaveLength(1);
    expect(base.search.mock.calls[0][0][0].indexName).toBe(MODELS_SEARCH_INDEX);
    expect(response.results).toHaveLength(2);
    expect(response.results[0].hits).toEqual([]);
    expect(response.results[1].hits).toEqual([{ id: 77 }]);
  });

  it('reports a repeated rejection once, and caps distinct ones at ten per client', async () => {
    const client = withSearchFilterGuard(makeClient());
    const send = (filters: string) =>
      client.search([{ indexName: MODELS_SEARCH_INDEX, params: { query: 'cat', filters } }] as any);

    await send(`nope0 = 1`);
    await send(`nope0 = 1`);
    expect(pushError).toHaveBeenCalledTimes(1);

    // 13 distinct signatures, a count the cap cannot equal in either direction: uncapped
    // would report 13, and a cap of 1 would leave this at 1.
    for (let i = 1; i < 13; i++) await send(`nope${i} = 1`);
    expect(pushError).toHaveBeenCalledTimes(10);
  });

  it('keeps reporting per client instance, so a fresh page is not pre-silenced', async () => {
    const first = withSearchFilterGuard(makeClient());
    await first.search([
      { indexName: MODELS_SEARCH_INDEX, params: { query: 'cat', filters: `nope = 1` } },
    ] as any);
    expect(pushError).toHaveBeenCalledTimes(1);

    const second = withSearchFilterGuard(makeClient());
    await second.search([
      { indexName: MODELS_SEARCH_INDEX, params: { query: 'cat', filters: `nope = 1` } },
    ] as any);
    expect(pushError).toHaveBeenCalledTimes(2);
  });

  it('keeps the response fields that sit beside `results` on the partial-rejection path', async () => {
    // The re-interleaved response is rebuilt, so anything the base client returned alongside
    // `results` has to be carried over rather than dropped.
    const base = makeClient({
      search: vi.fn().mockResolvedValue({ ...okResponse(1), processingTimeMS: 37 }),
    });
    const client = withSearchFilterGuard(base);

    const response = (await client.search([
      { indexName: IMAGES_SEARCH_INDEX, params: { query: 'cat', filters: MODELS_FILTER_SET } },
      { indexName: MODELS_SEARCH_INDEX, params: { query: 'cat', filters: MODELS_FILTER_SET } },
    ] as any)) as any;

    expect(response.processingTimeMS).toBe(37);
  });

  it('propagates a base-client rejection rather than swallowing it', async () => {
    // The resilient wrapper outside this one owns the fallback; swallowing here would hide a
    // real outage behind an empty dropdown with no beacon at all.
    const failure = new Error('NetworkError when attempting to fetch resource');
    const client = withSearchFilterGuard(
      makeClient({ search: vi.fn().mockRejectedValue(failure) })
    );

    await expect(
      client.search([
        { indexName: IMAGES_SEARCH_INDEX, params: { query: 'cat', filters: MODELS_FILTER_SET } },
        { indexName: MODELS_SEARCH_INDEX, params: { query: 'cat', filters: MODELS_FILTER_SET } },
      ] as any)
    ).rejects.toThrow(failure);
  });

  it('a rejection is not a backend failure, so it never raises the availability banner', async () => {
    const { createResilientSearchClient } = await import(
      '~/components/Search/resilientSearchClient'
    );
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const client = createResilientSearchClient(withSearchFilterGuard(makeClient()), {
      onError,
      onSuccess,
    });

    await client.search([
      { indexName: IMAGES_SEARCH_INDEX, params: { query: 'cat', filters: MODELS_FILTER_SET } },
    ] as any);

    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
