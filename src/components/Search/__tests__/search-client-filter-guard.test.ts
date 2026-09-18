import { globSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_FILTER_GUARD_ERROR_TYPE } from '~/components/Search/searchFilterGuard';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';

/**
 * The defect this pins, on the SHIPPED clients rather than on the guard in isolation.
 *
 * An `<InstantSearch>` that is UPDATED rather than rebuilt on a target switch can issue a search
 * with the previous target's `<Configure filters>`: react-instantsearch sets the new index and
 * searches in its render body, before the children that own `filters` re-render. Measured in
 * production as a run of backend 400s: a models filter set arriving at the images index
 * (`user.id`, `availability`), and `poi` at indexes that never intend it.
 *
 * The dropdown surfaces now also carry `key={indexName}`, so they are rebuilt and there is no
 * stale filter set left to send — see `dropdown-index-remount.test.ts`, and `useCarriedSearchText`
 * for how the typed query survives that remount. (An earlier revision of this header said the
 * dropdowns *could not* be keyed, because remounting would clear what the user is typing. That is
 * what the carrier fixes.) This guard stays as the request-level backstop: it does not depend on
 * any component keeping its key, and it covers any future path that assembles a filter set for one
 * index and sends it to another.
 *
 * The assertion that matters is the NEGATIVE one — the doomed request must not be SENT. A test
 * that only checked the response shape would pass on the pre-change code, which already degrades
 * a backend 400 to empty results.
 *
 * 🔴 Every surface is exercised THROUGH ITS OWN EXPORTED CLIENT. An earlier revision checked the
 * two `.tsx` surfaces by grepping their source for `withSearchFilterGuard(`, and that check was
 * shown to be worthless: constructing a guarded client and then calling the UNGUARDED one
 * restores the production defect with the searched-for string still present, and no test went
 * red. Source text cannot tell a wrapper that is used from one that is merely built.
 */

const { baseSearch, faro } = vi.hoisted(() => ({
  baseSearch: vi.fn(),
  faro: {} as Record<string, unknown>,
}));

vi.mock('@grafana/faro-web-sdk', () => ({ faro }));
vi.mock('@meilisearch/instant-meilisearch', () => ({
  instantMeiliSearch: () => ({
    search: baseSearch,
    searchForFacetValues: vi.fn(),
    clearCache: vi.fn(),
  }),
}));

const pushError = vi.fn();
let consoleError: ReturnType<typeof vi.spyOn>;

/** Hits with no `user.id`, so `withUserHydration` short-circuits and never reaches tRPC. */
const passthrough = {
  results: [
    {
      hits: [{ id: 42 }],
      nbHits: 1,
      nbPages: 1,
      page: 0,
      hitsPerPage: 1,
      processingTimeMS: 2,
      query: 'cat',
      params: '',
    },
  ],
};

beforeEach(() => {
  // Each client is a module singleton holding its own report budget. Without this, the second
  // test to send a given filter set would be deduplicated and read as a missing beacon.
  vi.resetModules();
  baseSearch.mockReset();
  baseSearch.mockResolvedValue(passthrough);
  pushError.mockClear();
  for (const key of Object.keys(faro)) delete faro[key];
  Object.assign(faro, { api: { pushError } });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => consoleError.mockRestore());

// The models filter set, verbatim in shape. `user.id`/`availability` are models-only; `poi`
// and `minor` exist on images too, so only two of the four may be reported.
const MODELS_FILTER_SET = `(poi != true OR user.id = 4711) AND (minor != true) AND (availability != Private OR user.id = 4711)`;

// The set the same component builds when its target really is images.
const IMAGES_FILTER_SET = `(poi != true OR user.username = 'someone') AND (minor != true) AND (nsfwLevel=1 OR nsfwLevel=2)`;

const request = (filters: string) => [
  { indexName: IMAGES_SEARCH_INDEX, params: { query: 'cat', filters } },
];

/**
 * Every browser search client built by the shared factory — i.e. every surface whose
 * `<InstantSearch>` takes its `indexName` from component state, and which therefore assembles a
 * filter set per target. Their roots are keyed as well, so in practice the stale set is never
 * built; this asserts the backstop independently of that, because a client is guarded or not
 * regardless of what any component does with it.
 */
const GUARDED_CLIENTS: [label: string, load: () => Promise<{ client: unknown }>][] = [
  [
    'autocompleteSearchClient (app-wide header search)',
    async () => ({
      client: (await import('~/components/Search/autocomplete.client')).autocompleteSearchClient,
    }),
  ],
  [
    'quickSearchClient (QuickSearchDropdown, default branch)',
    async () => ({
      client: (await import('~/components/Search/quick-search.client')).quickSearchClient,
    }),
  ],
  [
    'searchClient (QuickSearchDropdown, disableInitialSearch branch)',
    async () => ({ client: (await import('~/components/Search/search.client')).searchClient }),
  ],
];

describe.each(GUARDED_CLIENTS)('%s', (_label, load) => {
  it('does not send a search whose filters name attributes the target index lacks, and beacons it', async () => {
    const { client } = await load();

    const response = (await (client as any).search(request(MODELS_FILTER_SET))) as any;

    expect(baseSearch).not.toHaveBeenCalled();
    expect(response.results).toHaveLength(1);
    expect(response.results[0].hits).toEqual([]);

    expect(pushError).toHaveBeenCalled();
    const payload = pushError.mock.calls[0][1] as any;
    expect(payload.type).toBe(SEARCH_FILTER_GUARD_ERROR_TYPE);
    expect(payload.context.indexes).toBe(IMAGES_SEARCH_INDEX);
    expect(payload.context.attributes.split(',').sort()).toEqual(['availability', 'user.id']);
  });

  it('POSITIVE CONTROL: a filter set built for the index it targets is sent as before', async () => {
    const { client } = await load();

    const response = await (client as any).search(request(IMAGES_FILTER_SET));

    expect(baseSearch).toHaveBeenCalledTimes(1);
    expect(response).toBe(passthrough);
    expect(pushError).not.toHaveBeenCalled();
  });
});

/**
 * A DERIVED ledger, not a list: it enumerates every module that builds a Meilisearch client and
 * requires each to be classified. It fails when the population GROWS (a new surface nobody
 * guarded) and when an exclusion's stated REASON stops holding — an earlier hardcoded version
 * could do neither, so it read as coverage while asserting almost nothing.
 */
const GUARDED_CLIENT_FACTORY = 'src/components/Search/search-client-factory.ts';

/**
 * Construction sites that do not need the guard, each with the reason asserted below.
 *
 * The discriminator is that these build their own client instead of going through the factory —
 * NOT that they are the only keyed roots. Every dropdown root is keyed too; these two are listed
 * because they never reach `createSearchClient`, and each still has to say why it cannot leak.
 */
const EXCLUDED_CLIENT_SITES: Record<string, { reason: string; mustMatch: RegExp }> = {
  // Remounts on every index change, so the helper can never carry the previous index's filters.
  'src/components/Search/SearchLayout.tsx': {
    reason: 'carries key={indexName}',
    mustMatch: /key=\{indexName\}/,
  },
  // Targets one index for the lifetime of the modal — there is no switch to leak across.
  'src/components/CollectionSelectModal/CollectionSelectModal.tsx': {
    reason: 'targets a constant index',
    mustMatch: /indexName=\{searchIndexMap\.collections\}/,
  },
};

describe('search-client ledger', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');

  // A full-suite run can create directories under `src/` while this walk is happening, and one
  // whose name matches the glob reaches `readFileSync` as EISDIR — a COLLECTION failure, which
  // contributes zero tests and moves no failure count. Skip anything that is not a regular file.
  const isFile = (file: string) => {
    try {
      return statSync(path.join(repoRoot, file)).isFile();
    } catch {
      return false;
    }
  };

  const constructionSites = globSync('src/**/*.{ts,tsx}', { cwd: repoRoot })
    .map((file) => file.replace(/\\/g, '/'))
    .filter((file) => !file.includes('.test.') && isFile(file))
    .filter((file) =>
      readFileSync(path.join(repoRoot, file), 'utf8').includes('instantMeiliSearch(')
    );

  it('finds the construction sites at all (positive control for the scan)', () => {
    expect(constructionSites).toContain(GUARDED_CLIENT_FACTORY);
  });

  it('classifies every Meilisearch client construction site', () => {
    const unclassified = constructionSites.filter(
      (file) => file !== GUARDED_CLIENT_FACTORY && !(file in EXCLUDED_CLIENT_SITES)
    );
    expect(
      unclassified,
      `these modules build a Meilisearch client without going through ${GUARDED_CLIENT_FACTORY}. Either use the factory (so the filter guard applies), or add the file to EXCLUDED_CLIENT_SITES with the reason it cannot leak a filter set across an index switch — and assert that reason`
    ).toEqual([]);
  });

  it('holds each exclusion to the reason it claims', () => {
    for (const [file, { reason, mustMatch }] of Object.entries(EXCLUDED_CLIENT_SITES)) {
      const source = readFileSync(path.join(repoRoot, file), 'utf8');
      expect(
        mustMatch.test(source),
        `${file} is excluded from the filter guard because it ${reason}; that is no longer true, so it can now leak a filter set across an index switch`
      ).toBe(true);
    }
  });

  it('the factory applies the guard', () => {
    const source = readFileSync(path.join(repoRoot, GUARDED_CLIENT_FACTORY), 'utf8');
    expect(source).toContain('withSearchFilterGuard(');
  });
});
