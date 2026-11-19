import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type {
  ListAppListingsInput,
  ListingCard,
  StoreGridItem,
} from '~/server/schema/blocks/app-listing-read.schema';
import { NsfwLevel } from '~/server/common/enums';
import { instrumentationRegistry } from '@civitai/telemetry/client';
import type { AppIndexSearchReason } from '~/server/prom/app-index-search.metrics';
import type { ListAvailableListingsOpts } from '~/server/services/blocks/app-listing.service';

const h = {
  listAvailableListings: vi.fn(),
  listStoreListingsBySlugs: vi.fn(),
};

const { listStoreGrid: listStoreGridWith, APP_INDEX_SEARCH_TIMEOUT_MS } = await import(
  '~/server/services/blocks/app-index-search.service'
);

// The database reads are passed in (the service's `reads` parameter), never module-mocked.
const listStoreGrid = (...args: Parameters<typeof listStoreGridWith>) =>
  listStoreGridWith(args[0], args[1], args[2], {
    listAvailableListings: h.listAvailableListings,
    listStoreListingsBySlugs: h.listStoreListingsBySlugs,
  });

const INDEX_URL = 'http://app-index.invalid/base/';

type CardFields = {
  slug: string;
  name: string;
  tagline: string | null;
  iconUrl: string | null;
  contentRating: string | null;
};

function card(f: CardFields): ListingCard {
  return { id: `al_${f.slug}`, ...f } as unknown as ListingCard;
}

// What the database hydrates (and the user sees) for each slug.
const ALPHA: CardFields = {
  slug: 'alpha',
  name: 'Alpha Pixel',
  tagline: null,
  iconUrl: 'https://cdn.invalid/alpha.png',
  contentRating: 'g',
};
const BETA: CardFields = {
  slug: 'beta',
  name: 'Beta',
  tagline: 'pixel tools',
  iconUrl: null,
  contentRating: 'PG',
};
const DELTA: CardFields = {
  slug: 'delta',
  name: 'Delta',
  tagline: 'draws things',
  iconUrl: 'https://cdn.invalid/delta.png',
  contentRating: 'g',
};

type IndexResult = { slug: string; name: string; tagline: string; iconUrl: string; rating: string };

/** The index's copy of a card, identical field for field (the index answers '' for none). */
function indexed(f: CardFields, over: Partial<IndexResult> = {}): IndexResult {
  return {
    slug: f.slug,
    name: f.name,
    tagline: f.tagline ?? '',
    iconUrl: f.iconUrl ?? '',
    rating: f.contentRating ?? '',
    ...over,
  };
}

const DB_ITEMS: StoreGridItem[] = [
  card(ALPHA),
  card(BETA),
  card({ ...DELTA, slug: 'gamma', name: 'Gamma', tagline: null }),
  {
    id: 'asl_1',
    cardType: 'sub-listing',
    name: 'Pixel child',
    tagline: null,
  } as unknown as StoreGridItem,
];
const DB_PAGE = { items: DB_ITEMS, nextCursor: 'db-cursor' };

const INPUT: ListAppListingsInput = {
  kind: 'onsite',
  category: 'generation',
  sort: 'top-rated',
  limit: 48,
  includeSubListings: true,
  query: 'pixel',
};
const SFW_OPTS = { redCapable: false, scope: 'full' as const, viewerBrowsingLevel: NsfwLevel.PG };

let fetchCalls: string[];
let logLines: string[];
let hydrated: Map<string, ListingCard>;

type IndexReply = () => Promise<Response> | Response;
function stubIndex(reply: IndexReply) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    fetchCalls.push(url);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return reply();
  });
}
function indexAnswers(results: IndexResult[]) {
  stubIndex(() => Response.json({ results }));
}

// The real counters, read from the registry `/api/metrics` scrapes. They are process-wide, so
// every assertion is on how far a series moved since this test began.
const REQUESTS = 'civitai_app_index_search_requests_total';
const FIELD_DIFFS = 'civitai_app_index_search_field_diffs_total';
async function readCounter(name: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const metric = instrumentationRegistry.getSingleMetric(name);
  if (!metric) return out;
  for (const v of (await metric.get()).values) {
    const key = Object.values(v.labels).join('/');
    out.set(key, (out.get(key) ?? 0) + v.value);
  }
  return out;
}
let baseline: { requests: Map<string, number>; diffs: Map<string, number> };
async function moved(name: string, before: Map<string, number>): Promise<string[]> {
  const now = await readCounter(name);
  return [...now]
    .filter(([k, v]) => v > (before.get(k) ?? 0))
    .map(([k, v]) => `${k}:${v - (before.get(k) ?? 0)}`)
    .sort();
}
/** The request counter series that moved since the test began, as `source/reason:delta`. */
const requestsMoved = () => moved(REQUESTS, baseline.requests);
/** The field diff counter series that moved since the test began, as `field:delta`. */
const fieldDiffsMoved = () => moved(FIELD_DIFFS, baseline.diffs);
/** Lets fire-and-forget work queued by the service (the sampled comparison) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  // Every request compares unless a test says otherwise, so the log lines carry db and overlap.
  setEnv({ APP_INDEX_URL: INDEX_URL, APP_INDEX_SEARCH_COMPARE_SAMPLE: 1 });
  fetchCalls = [];
  logLines = [];
  h.listAvailableListings.mockReset().mockResolvedValue(DB_PAGE);
  // Hydration returns the cards of the slugs it is given, in that order (the real read keeps
  // the given order: `idsInSlugOrder`).
  hydrated = new Map<string, ListingCard>();
  for (const f of [ALPHA, BETA, DELTA]) hydrated.set(f.slug, card(f));
  h.listStoreListingsBySlugs.mockReset().mockImplementation(async (slugs: string[]) =>
    slugs.flatMap((s): ListingCard[] => {
      const c = hydrated.get(s);
      return c ? [c] : [];
    })
  );
  baseline = { requests: await readCounter(REQUESTS), diffs: await readCounter(FIELD_DIFFS) };
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    logLines.push(String(args[0]));
  });
  indexAnswers([
    indexed(DELTA),
    indexed(BETA, { rating: 'pg' }),
    { slug: 'unlisted', name: 'Unlisted', tagline: '', iconUrl: '', rating: 'g' },
    indexed(ALPHA),
  ]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('listStoreGrid', () => {
  it('flag off: the database path, untouched', async () => {
    const opts = { ...SFW_OPTS };
    const res = await listStoreGrid(INPUT, opts, { indexSearch: false });
    expect(res).toBe(DB_PAGE);
    expect(h.listAvailableListings).toHaveBeenCalledTimes(1);
    expect(h.listAvailableListings.mock.calls[0][0]).toBe(INPUT);
    expect(h.listAvailableListings.mock.calls[0][1]).toBe(opts);
    expect(fetchCalls).toEqual([]);
    expect(h.listStoreListingsBySlugs).not.toHaveBeenCalled();
    await settle();
    expect(await requestsMoved()).toEqual([]);
    expect(await fieldDiffsMoved()).toEqual([]);
    expect(logLines).toEqual([]);
  });

  it('flag on without a query: the database path, untouched', async () => {
    for (const query of [undefined, '', '   ']) {
      h.listAvailableListings.mockClear();
      const input = { ...INPUT, query };
      const res = await listStoreGrid(input, SFW_OPTS, { indexSearch: true });
      // The database page as is, plus the routability the client keys its request on.
      expect(res).toEqual({ ...DB_PAGE, indexSearchRoutable: true });
      expect(h.listAvailableListings.mock.calls[0][0]).toBe(input);
    }
    expect(fetchCalls).toEqual([]);
    expect(await requestsMoved()).toEqual([]);
  });

  it('flag on, SFW viewer: the index answers, in its order, with database cards', async () => {
    const res = await listStoreGrid(INPUT, SFW_OPTS, { indexSearch: true });

    expect(fetchCalls).toEqual([
      'http://app-index.invalid/base/search?q=pixel&limit=48&kind=onsite&category=generation',
    ]);
    // The index's order, not the database page's (alpha, beta, gamma).
    expect(h.listStoreListingsBySlugs).toHaveBeenCalledWith(
      ['delta', 'beta', 'unlisted', 'alpha'],
      INPUT,
      SFW_OPTS
    );
    // The cards are the database's, never built from the index's fields.
    expect(res).toEqual({
      items: [card(DELTA), card(BETA), card(ALPHA)],
      nextCursor: undefined,
      search: 'index',
      indexSearchRoutable: true,
    });
    expect(await requestsMoved()).toEqual(['index/ok:1']);
    // Identical fields (BETA's rating differs only in case): no field counter moves.
    expect(await fieldDiffsMoved()).toEqual([]);
    await settle();
    // db: alpha (name) and beta (tagline) contain "pixel"; the sub-listing is not a listing.
    // overlap: beta and alpha; dropped: "unlisted", which the store gates did not return.
    expect(logLines).toEqual([
      'app-index-search: q_len=5 index=3 db=2 overlap=2 dropped=1 source=index reason=ok ' +
        'field_diffs=name:0,tagline:0,iconUrl:0,rating:0 field_expected=iconUrl:0,rating:0',
    ]);
    expect(logLines[0]).not.toContain('pixel');
  });

  // The index's copy of DELTA differs from the database card on exactly one field.
  it.each<[string, Partial<IndexResult>, string]>([
    ['name', { name: 'Delta Renamed Upstream' }, 'name:1,tagline:0,iconUrl:0,rating:0'],
    ['tagline', { tagline: 'a stale upstream tagline' }, 'name:0,tagline:1,iconUrl:0,rating:0'],
    [
      'iconUrl (another icon)',
      { iconUrl: 'https://cdn.invalid/delta-previous.png' },
      'name:0,tagline:0,iconUrl:1,rating:0',
    ],
    ['iconUrl (none in the index)', { iconUrl: '' }, 'name:0,tagline:0,iconUrl:1,rating:0'],
    ['rating', { rating: 'pg13' }, 'name:0,tagline:0,iconUrl:0,rating:1'],
  ])('a different %s is counted as a diff of that field only', async (field, over, counts) => {
    indexAnswers([indexed(DELTA, over), indexed(BETA), indexed(ALPHA)]);
    const res = await listStoreGrid(INPUT, SFW_OPTS, { indexSearch: true });
    expect(res.items).toEqual([card(DELTA), card(BETA), card(ALPHA)]);
    expect(await fieldDiffsMoved()).toEqual([`${field.split(' ')[0]}:1`]);
    await settle();
    expect(logLines).toEqual([
      'app-index-search: q_len=5 index=3 db=2 overlap=2 dropped=0 source=index reason=ok ' +
        `field_diffs=${counts} field_expected=iconUrl:0,rating:0`,
    ]);
    expect(logLines[0]).not.toContain(Object.values(over)[0] || '\u0000');
  });

  it.each<[string, CardFields, IndexResult, boolean, string]>([
    [
      'an icon the viewer level hides on the card',
      { ...DELTA, iconUrl: null },
      indexed(DELTA),
      false,
      'iconUrl:1,rating:0',
    ],
    [
      'the red-host icon override on a red-capable request',
      { ...DELTA, iconUrl: 'https://cdn.invalid/delta-red-override.png' },
      indexed(DELTA),
      true,
      'iconUrl:1,rating:0',
    ],
    [
      'a listing rating the registry does not publish',
      { ...DELTA, contentRating: null },
      indexed(DELTA, { rating: 'pg' }),
      false,
      'iconUrl:0,rating:1',
    ],
  ])('%s is expected, not a diff', async (_, dbCard, idx, redCapable, expected) => {
    hydrated.set('delta', card(dbCard));
    indexAnswers([idx]);
    await listStoreGrid(INPUT, { ...SFW_OPTS, redCapable }, { indexSearch: true });
    expect(await fieldDiffsMoved()).toEqual([]);
    await settle();
    expect(logLines[0]).toContain(
      `field_diffs=name:0,tagline:0,iconUrl:0,rating:0 field_expected=${expected}`
    );
  });

  it('two different icons off a red-capable host are a diff, not an override', async () => {
    hydrated.set(
      'delta',
      card({ ...DELTA, iconUrl: 'https://cdn.invalid/delta-red-override.png' })
    );
    indexAnswers([indexed(DELTA)]);
    await listStoreGrid(INPUT, SFW_OPTS, { indexSearch: true });
    expect(await fieldDiffsMoved()).toEqual(['iconUrl:1']);
  });

  it.each<[string, IndexReply, AppIndexSearchReason]>([
    ['a 500', () => new Response('{"error":"internal"}', { status: 500 }), 'error'],
    [
      'a 503 before the index is ready',
      () => Response.json({ error: 'not_ready' }, { status: 503 }),
      'not_ready',
    ],
    [
      'a body that is not a search response',
      () => Response.json({ results: [{ slug: 'x' }] }),
      'bad_response',
    ],
    ['a body that is not JSON', () => new Response('<html>'), 'bad_response'],
    [
      'a timeout',
      () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
      'timeout',
    ],
    ['a connection error', () => Promise.reject(new TypeError('fetch failed')), 'error'],
  ])('index answers %s: the database page, as before', async (_, reply, reason) => {
    stubIndex(reply);
    const res = await listStoreGrid(INPUT, SFW_OPTS, { indexSearch: true });
    expect(res).toEqual({ ...DB_PAGE, indexSearchRoutable: true });
    expect(fetchCalls).toHaveLength(1);
    expect(h.listStoreListingsBySlugs).not.toHaveBeenCalled();
    expect(await requestsMoved()).toEqual([`db_fallback/${reason}:1`]);
    expect(await fieldDiffsMoved()).toEqual([]);
    expect(logLines).toEqual([
      'app-index-search: q_len=5 index=0 db=2 overlap=0 dropped=0 source=db_fallback ' +
        `reason=${reason} field_diffs=none field_expected=none`,
    ]);
  });

  it('hydration failure: the database page', async () => {
    h.listStoreListingsBySlugs.mockRejectedValue(new Error('db'));
    const res = await listStoreGrid(INPUT, SFW_OPTS, { indexSearch: true });
    expect(res).toEqual({ ...DB_PAGE, indexSearchRoutable: true });
    expect(await requestsMoved()).toEqual(['db_fallback/error:1']);
  });

  it('a viewer who may see r/x listings is never sent to the index', async () => {
    for (const viewerBrowsingLevel of [NsfwLevel.R, NsfwLevel.X, NsfwLevel.PG | NsfwLevel.R]) {
      const res = await listStoreGrid(
        INPUT,
        { ...SFW_OPTS, redCapable: true, viewerBrowsingLevel },
        { indexSearch: true }
      );
      expect(res).toEqual({ ...DB_PAGE, indexSearchRoutable: false });
    }
    expect(await requestsMoved()).toEqual(['db_fallback/mature_viewer:3']);
    expect(fetchCalls).toEqual([]);
  });

  it('an SFW level on a mature-capable host is still routed', async () => {
    const res = await listStoreGrid(
      INPUT,
      { ...SFW_OPTS, redCapable: true, viewerBrowsingLevel: NsfwLevel.PG | NsfwLevel.PG13 },
      { indexSearch: true }
    );
    expect(res.search).toBe('index');
  });

  it.each<[string, Partial<ListAppListingsInput>, () => void, AppIndexSearchReason, boolean]>([
    ['no APP_INDEX_URL', {}, () => setEnv({ APP_INDEX_URL: undefined }), 'no_url', false],
    ['a store cursor', { cursor: 'abc' }, () => undefined, 'unsupported_input', true],
    ['a developer filter', { userId: 7 }, () => undefined, 'unsupported_input', true],
  ])('%s: the database page', async (_, extra, setup, reason, routable) => {
    setup();
    const res = await listStoreGrid({ ...INPUT, ...extra }, SFW_OPTS, { indexSearch: true });
    expect(res).toEqual({ ...DB_PAGE, indexSearchRoutable: routable });
    expect(fetchCalls).toEqual([]);
    expect(await requestsMoved()).toEqual([`db_fallback/${reason}:1`]);
  });

  // The index could leave out listings the database grid shows these viewers, so they keep it.
  it.each<[string, Partial<ListAvailableListingsOpts>, AppIndexSearchReason]>([
    ['a tester floor', { floor: 'testers' }, 'unsupported_viewer'],
    ['a moderator floor', { floor: 'moderators' }, 'unsupported_viewer'],
    ['sub-listing cards in the grid', { includeSubListings: true }, 'sub_listings'],
  ])('%s: the database page, and not routable', async (_, extra, reason) => {
    const res = await listStoreGrid(INPUT, { ...SFW_OPTS, ...extra }, { indexSearch: true });
    expect(res).toEqual({ ...DB_PAGE, indexSearchRoutable: false });
    expect(fetchCalls).toEqual([]);
    expect(h.listStoreListingsBySlugs).not.toHaveBeenCalled();
    expect(await requestsMoved()).toEqual([`db_fallback/${reason}:1`]);
    // Not routable is said even on a page without a query, so the client never sends one.
    const plain = await listStoreGrid(
      { ...INPUT, query: undefined },
      { ...SFW_OPTS, ...extra },
      {
        indexSearch: true,
      }
    );
    expect(plain.indexSearchRoutable).toBe(false);
  });

  it.each<[string, Partial<ListAppListingsInput>, Partial<ListAvailableListingsOpts>, string]>([
    ['public-external scope, any kind', { kind: 'all' }, { scope: 'public-external' }, 'offsite'],
    [
      'public-external scope, on-site asked',
      { kind: 'onsite' },
      { scope: 'public-external' },
      'offsite',
    ],
    ['full scope, the request kind', { kind: 'offsite' }, { scope: 'full' }, 'offsite'],
    ['full scope, all kinds', { kind: 'all' }, { scope: 'full' }, ''],
  ])('%s: the index is asked for the right kind', async (_, input, opts, kind) => {
    await listStoreGrid({ ...INPUT, ...input }, { ...SFW_OPTS, ...opts }, { indexSearch: true });
    expect(fetchCalls).toHaveLength(1);
    expect(new URL(fetchCalls[0]).searchParams.get('kind') ?? '').toBe(kind);
  });

  it('an index that does not answer is abandoned at its deadline for the database page', async () => {
    // The index holds the request open until the service's own deadline aborts it.
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      fetchCalls.push(url);
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    });
    const start = Date.now();
    const res = await listStoreGrid(INPUT, SFW_OPTS, { indexSearch: true });
    const waited = Date.now() - start;
    expect(res).toEqual({ ...DB_PAGE, indexSearchRoutable: true });
    expect(await requestsMoved()).toEqual(['db_fallback/timeout:1']);
    // At its deadline: not before it, and not long after.
    expect(waited).toBeGreaterThanOrEqual(APP_INDEX_SEARCH_TIMEOUT_MS - 20);
    expect(waited).toBeLessThan(APP_INDEX_SEARCH_TIMEOUT_MS + 2_000);
  });

  it('an index answer does not wait for a slow database page', async () => {
    let releaseDb: (page: typeof DB_PAGE) => void = () => undefined;
    h.listAvailableListings.mockReset().mockReturnValue(
      new Promise((resolve) => {
        releaseDb = resolve;
      })
    );
    const res = await listStoreGrid(INPUT, SFW_OPTS, { indexSearch: true });
    // Answered while the database page is still pending.
    expect(res.search).toBe('index');
    expect(h.listAvailableListings).toHaveBeenCalledTimes(1);
    expect(await requestsMoved()).toEqual(['index/ok:1']);
    await settle();
    expect(logLines).toEqual([]);
    // The comparison is logged once the database page arrives.
    releaseDb(DB_PAGE);
    await settle();
    expect(logLines).toEqual([
      'app-index-search: q_len=5 index=3 db=2 overlap=2 dropped=1 source=index reason=ok ' +
        'field_diffs=name:0,tagline:0,iconUrl:0,rating:0 field_expected=iconUrl:0,rating:0',
    ]);
  });

  it('a failing sampled database read never fails the index answer', async () => {
    h.listAvailableListings.mockReset().mockRejectedValue(new Error('db down'));
    const res = await listStoreGrid(INPUT, SFW_OPTS, { indexSearch: true });
    expect(res.search).toBe('index');
    await settle();
    expect(logLines[0]).toContain('db=-1 overlap=0');
  });

  it('sample 0: an index answer reads no database page', async () => {
    setEnv({ APP_INDEX_SEARCH_COMPARE_SAMPLE: 0 });
    const res = await listStoreGrid(INPUT, SFW_OPTS, { indexSearch: true });
    expect(res.search).toBe('index');
    await settle();
    expect(h.listAvailableListings).not.toHaveBeenCalled();
    expect(await requestsMoved()).toEqual(['index/ok:1']);
    expect(logLines).toEqual([
      'app-index-search: q_len=5 index=3 db=none overlap=none dropped=1 source=index reason=ok ' +
        'field_diffs=name:0,tagline:0,iconUrl:0,rating:0 field_expected=iconUrl:0,rating:0',
    ]);
  });

  it.each<[string, number]>([
    ['sampled: the database read already in flight', 1],
    ['unsampled: one database read, after the index failed', 0],
  ])('index failure, %s, is the fallback', async (_, sample) => {
    setEnv({ APP_INDEX_SEARCH_COMPARE_SAMPLE: sample });
    stubIndex(() => new Response('{"error":"internal"}', { status: 500 }));
    const res = await listStoreGrid(INPUT, SFW_OPTS, { indexSearch: true });
    expect(res).toEqual({ ...DB_PAGE, indexSearchRoutable: true });
    expect(h.listAvailableListings).toHaveBeenCalledTimes(1);
    expect(await requestsMoved()).toEqual(['db_fallback/error:1']);
  });
});
