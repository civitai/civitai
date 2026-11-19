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
import type {
  IndexBreaker as IndexBreakerType,
  StoreGridViewer,
} from '~/server/services/blocks/app-index-search.service';

const h = {
  listAvailableListings: vi.fn(),
  listStoreListingsBySlugs: vi.fn(),
};

const {
  listStoreGrid: listStoreGridWith,
  storeGridRequest,
  APP_INDEX_SEARCH_TIMEOUT_MS,
  IndexBreaker,
} = await import('~/server/services/blocks/app-index-search.service');

// The database reads are passed in (the service's `reads` parameter), never module-mocked, and
// so is the breaker: a fresh one per test, so no test inherits another's failures.
let breaker: IndexBreakerType;
const listStoreGrid = (...args: Parameters<typeof listStoreGridWith>) =>
  listStoreGridWith(
    args[0],
    args[1],
    args[2],
    {
      listAvailableListings: h.listAvailableListings,
      listStoreListingsBySlugs: h.listStoreListingsBySlugs,
    },
    breaker
  );

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
  breaker = new IndexBreaker();
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
  vi.useRealTimers();
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
    // The one exact pin of the whole line; the other tests check only the part they are about.
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
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain(` field_diffs=${counts} `);
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
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain(` source=db_fallback reason=${reason} `);
  });

  it('hydration failure: the database page, counted as the database’s failure', async () => {
    h.listStoreListingsBySlugs.mockRejectedValue(new Error('db'));
    const res = await listStoreGrid(INPUT, SFW_OPTS, { indexSearch: true });
    expect(res).toEqual({ ...DB_PAGE, indexSearchRoutable: true });
    // Not `error`: the index answered, so it must not read as an index failure.
    expect(await requestsMoved()).toEqual(['db_fallback/db_error:1']);
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
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain(' db=2 overlap=2 ');
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
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain(' db=none overlap=none ');
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

// The `/apps` store grid always asks for sub-listing cards; the index holds none.
describe('listStoreGrid with sub-listing cards on the page', () => {
  const subCard = (id: string, name: string, tagline: string | null): StoreGridItem =>
    ({ id, cardType: 'sub-listing', name, tagline } as unknown as StoreGridItem);
  // Pairwise distinct, in the database page's order: one matches by tagline (in upper case), one
  // by name, one not at all.
  const SL_TAGLINE = subCard('asl_tagline', 'Canvas Kit', 'PIXEL brushes');
  const SL_NAME = subCard('asl_name', 'Pixelate Me', null);
  const SL_MISS = subCard('asl_miss', 'Sketch Pad', 'drawing aid');
  const SL_DB_PAGE = {
    items: [
      card(ALPHA),
      SL_TAGLINE,
      card(BETA),
      SL_MISS,
      SL_NAME,
      card({ ...DELTA, slug: 'gamma', name: 'Gamma', tagline: null }),
    ],
    nextCursor: 'db-cursor-sl',
  };
  const SL_OPTS = { ...SFW_OPTS, includeSubListings: true };

  beforeEach(() => {
    h.listAvailableListings.mockReset().mockResolvedValue(SL_DB_PAGE);
  });

  it('an index answer: its apps in its order, then the matching database sub-listings', async () => {
    // Unsampled: the sub-listing cards need the database page whatever the comparison sample.
    setEnv({ APP_INDEX_SEARCH_COMPARE_SAMPLE: 0 });
    const res = await listStoreGrid(INPUT, SL_OPTS, { indexSearch: true });
    expect(res).toEqual({
      items: [card(DELTA), card(BETA), card(ALPHA), SL_TAGLINE, SL_NAME],
      nextCursor: undefined,
      search: 'index',
      indexSearchRoutable: true,
    });
    // One database read, with the request's own input and gates.
    expect(h.listAvailableListings).toHaveBeenCalledTimes(1);
    expect(h.listAvailableListings).toHaveBeenCalledWith(INPUT, SL_OPTS);
    expect(await requestsMoved()).toEqual(['index/ok:1']);
    await settle();
    // Like with like: index=3 apps against the database's 2 matching apps; the sub-listing
    // cards are on neither side of the comparison.
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain(' index=3 db=2 overlap=2 dropped=1 source=index reason=ok ');
  });

  it.each<[string, IndexReply, AppIndexSearchReason]>([
    ['a 500', () => new Response('{"error":"internal"}', { status: 500 }), 'error'],
    [
      'a timeout',
      () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
      'timeout',
    ],
  ])(
    'index answers %s: the full database page, apps and sub-listings',
    async (_, reply, reason) => {
      stubIndex(reply);
      const res = await listStoreGrid(INPUT, SL_OPTS, { indexSearch: true });
      expect(res).toEqual({ ...SL_DB_PAGE, indexSearchRoutable: true });
      expect(res.search).toBeUndefined();
      expect(h.listAvailableListings).toHaveBeenCalledTimes(1);
      expect(await requestsMoved()).toEqual([`db_fallback/${reason}:1`]);
    }
  );

  it('a failed database read is not served as an index answer without sub-listings', async () => {
    h.listAvailableListings
      .mockReset()
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce(SL_DB_PAGE);
    const res = await listStoreGrid(INPUT, SL_OPTS, { indexSearch: true });
    // The database path, read afresh.
    expect(res).toEqual({ ...SL_DB_PAGE, indexSearchRoutable: true });
    expect(h.listAvailableListings).toHaveBeenCalledTimes(2);
    // The index answered; the database page failed.
    expect(await requestsMoved()).toEqual(['db_fallback/db_error:1']);
  });

  it('a database read that keeps failing is the request’s error, as with the flag off', async () => {
    h.listAvailableListings.mockReset().mockRejectedValue(new Error('db down'));
    await expect(listStoreGrid(INPUT, SL_OPTS, { indexSearch: true })).rejects.toThrow('db down');
  });
});

/**
 * The seam: the request the `/apps` store grid sends (`AppListingsMarketplaceBody`), turned into
 * `listStoreGrid`'s arguments by `storeGridRequest` (what `appListings.listAvailable` calls) under
 * the flags production runs with. The grid always asks for sub-listing cards, and with
 * `app-store-sub-listings` on that once made every viewer unroutable for the index
 * (`indexSearchRoutable: false` on every page, so the client never sent a query), while each
 * layer's own tests passed.
 */
describe('the store grid request, end to end', () => {
  /** Exactly what the store grid sends for a viewer who has not touched a filter. */
  const STORE_INPUT: ListAppListingsInput = {
    kind: 'all',
    category: undefined,
    sort: 'popular',
    limit: 48,
    includeSubListings: true,
  };
  const FLAGS_ON = { appStoreSubListings: true, appIndexSearch: true };
  /** A signed-in SFW viewer below the moderator floor, as the router reads them. */
  const SFW_VIEWER: StoreGridViewer = {
    features: FLAGS_ON,
    redCapable: false,
    scope: 'full',
    floor: 'public',
    viewer: { userId: 4242, isModerator: false },
    viewerBrowsingLevel: NsfwLevel.PG | NsfwLevel.PG13,
  };

  // Pairwise distinct names, slugs and ids.
  const LUMEN = card({ ...DELTA, slug: 'lumen-paint', name: 'Lumen Paint', tagline: null });
  const ORBIT = card({
    ...DELTA,
    slug: 'orbit-forge',
    name: 'Orbit Forge',
    tagline: 'lumen tools',
  });
  const QUILL = card({ ...DELTA, slug: 'quill-tavern', name: 'Quill Tavern', tagline: null });
  const SUB_LUMEN = {
    id: 'asl_lumen_brush',
    cardType: 'sub-listing',
    name: 'Lumen Brush Pack',
    tagline: null,
  } as unknown as StoreGridItem;
  const SUB_MARBLE = {
    id: 'asl_marble_run',
    cardType: 'sub-listing',
    name: 'Marble Run',
    tagline: null,
  } as unknown as StoreGridItem;

  /** Sub-listing cards only when the request asked for them, as the real read does. */
  function dbPage(opts: ListAvailableListingsOpts) {
    const items: StoreGridItem[] = [QUILL, LUMEN];
    if (opts.includeSubListings === true) items.push(SUB_MARBLE, SUB_LUMEN);
    items.push(ORBIT);
    return { items, nextCursor: 'cursor-page-2' };
  }
  const grid = (input: ListAppListingsInput, viewer: StoreGridViewer = SFW_VIEWER) =>
    listStoreGrid(input, ...storeGridRequest(input, viewer));

  beforeEach(() => {
    setEnv({ APP_INDEX_SEARCH_COMPARE_SAMPLE: 0 });
    h.listAvailableListings
      .mockReset()
      .mockImplementation(async (_: unknown, opts: ListAvailableListingsOpts) => dbPage(opts));
    h.listStoreListingsBySlugs
      .mockReset()
      .mockImplementation(async (slugs: string[]) =>
        slugs.flatMap((s) => [LUMEN, ORBIT, QUILL].filter((c) => c.slug === s))
      );
    indexAnswers([
      indexed({ ...DELTA, slug: 'orbit-forge' }),
      indexed({ ...DELTA, slug: 'lumen-paint' }),
    ]);
  });

  it('an SFW viewer is routable', async () => {
    const res = await grid(STORE_INPUT);
    expect(res.indexSearchRoutable).toBe(true);
    // The page the grid shows before a search carries the sub-listing cards.
    expect(res.items).toEqual([QUILL, LUMEN, SUB_MARBLE, SUB_LUMEN, ORBIT]);
    expect(fetchCalls).toEqual([]);
  });

  it('a search: the index apps in its order, then the matching database sub-listings', async () => {
    const res = await grid({ ...STORE_INPUT, query: 'lumen' });
    expect(fetchCalls).toEqual(['http://app-index.invalid/base/search?q=lumen&limit=48']);
    expect(res).toEqual({
      items: [ORBIT, LUMEN, SUB_LUMEN],
      nextCursor: undefined,
      search: 'index',
      indexSearchRoutable: true,
    });
    expect(await requestsMoved()).toEqual(['index/ok:1']);
  });

  it('sub-listings flag off: an index answer carries no sub-listing card', async () => {
    const res = await grid(
      { ...STORE_INPUT, query: 'lumen' },
      { ...SFW_VIEWER, features: { appIndexSearch: true } }
    );
    expect(res).toEqual({
      items: [ORBIT, LUMEN],
      nextCursor: undefined,
      search: 'index',
      indexSearchRoutable: true,
    });
  });

  it('an index failure serves the full database page, apps and sub-listings', async () => {
    stubIndex(() => new Response('{"error":"internal"}', { status: 500 }));
    const res = await grid({ ...STORE_INPUT, query: 'lumen' });
    expect(fetchCalls).toHaveLength(1);
    expect(res).toEqual({
      items: [QUILL, LUMEN, SUB_MARBLE, SUB_LUMEN, ORBIT],
      nextCursor: 'cursor-page-2',
      indexSearchRoutable: true,
    });
    expect(res.search).toBeUndefined();
    expect(await requestsMoved()).toEqual(['db_fallback/error:1']);
  });

  it.each<[string, Partial<StoreGridViewer>, AppIndexSearchReason]>([
    [
      'a viewer who may see R listings',
      { redCapable: true, viewerBrowsingLevel: NsfwLevel.PG | NsfwLevel.R },
      'mature_viewer',
    ],
    [
      'a moderator',
      { floor: 'moderators', viewer: { userId: 1, isModerator: true } },
      'unsupported_viewer',
    ],
  ])('%s is not routable', async (_, over, reason) => {
    const res = await grid({ ...STORE_INPUT, query: 'lumen' }, { ...SFW_VIEWER, ...over });
    expect(res.indexSearchRoutable).toBe(false);
    expect(res.search).toBeUndefined();
    expect(fetchCalls).toEqual([]);
    expect(await requestsMoved()).toEqual([`db_fallback/${reason}:1`]);
  });
});

/**
 * The per-process breaker around the index call (`IndexBreaker`). Threshold and cooldown are set
 * away from their defaults (5, 30s), so a breaker that ignored the env would be seen.
 */
describe('the index breaker', () => {
  const THRESHOLD = 3;
  const COOLDOWN_MS = 12_000;
  const T0 = new Date('2026-11-19T12:00:00Z').getTime();
  const BREAKER_STATE = 'civitai_app_index_search_breaker_state';
  const search = () => listStoreGrid(INPUT, SFW_OPTS, { indexSearch: true });
  const failing = () => stubIndex(() => new Response('{"error":"internal"}', { status: 500 }));
  const healthy = () => indexAnswers([indexed(DELTA), indexed(ALPHA)]);
  async function breakerState() {
    const metric = instrumentationRegistry.getSingleMetric(BREAKER_STATE);
    return metric ? (await metric.get()).values[0]?.value : undefined;
  }
  const breakerLines = () => logLines.filter((l) => l.startsWith('app-index-search: breaker'));
  /** Runs `n` searches one after another, as the store's users would. */
  async function searches(n: number) {
    for (let i = 0; i < n; i++) await search();
  }
  /** Opens the breaker: THRESHOLD failing searches. */
  async function trip() {
    failing();
    await searches(THRESHOLD);
    expect(fetchCalls).toHaveLength(THRESHOLD);
  }

  beforeEach(() => {
    setEnv({
      APP_INDEX_SEARCH_COMPARE_SAMPLE: 0,
      APP_INDEX_BREAKER_FAILURE_THRESHOLD: THRESHOLD,
      APP_INDEX_BREAKER_COOLDOWN_MS: COOLDOWN_MS,
    });
    // Only the clock: the index call's deadline and `settle` keep real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  it('opens after the threshold of consecutive failures, and then calls no index', async () => {
    failing();
    await searches(THRESHOLD - 1);
    expect(fetchCalls).toHaveLength(THRESHOLD - 1);
    expect(breakerLines()).toEqual([]);
    await search();
    expect(fetchCalls).toHaveLength(THRESHOLD);
    expect(breakerLines()).toEqual([
      `app-index-search: breaker closed->open consecutive_failures=${THRESHOLD} reason=error`,
    ]);
    expect(await breakerState()).toBe(2);

    // Open: the database page, one read per search, and no index call at all.
    h.listAvailableListings.mockClear();
    healthy();
    const res = await search();
    await searches(4);
    expect(res).toEqual({ ...DB_PAGE, indexSearchRoutable: true });
    expect(fetchCalls).toHaveLength(THRESHOLD);
    expect(h.listAvailableListings).toHaveBeenCalledTimes(5);
    expect(h.listStoreListingsBySlugs).not.toHaveBeenCalled();
    expect(await requestsMoved()).toEqual([
      'db_fallback/breaker_open:5',
      `db_fallback/error:${THRESHOLD}`,
    ]);
  });

  it('timeouts count as failures', async () => {
    stubIndex(() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')));
    await searches(THRESHOLD + 2);
    expect(fetchCalls).toHaveLength(THRESHOLD);
    expect(breakerLines()).toEqual([
      `app-index-search: breaker closed->open consecutive_failures=${THRESHOLD} reason=timeout`,
    ]);
    expect(await requestsMoved()).toEqual([
      'db_fallback/breaker_open:2',
      `db_fallback/timeout:${THRESHOLD}`,
    ]);
  });

  it('only consecutive failures open it: one index answer resets the count', async () => {
    failing();
    await searches(THRESHOLD - 1);
    healthy();
    await search();
    failing();
    await searches(THRESHOLD - 1);
    // 2 * (THRESHOLD - 1) failures, never THRESHOLD in a row: every search reached the index.
    expect(fetchCalls).toHaveLength(2 * (THRESHOLD - 1) + 1);
    expect(breakerLines()).toEqual([]);
    expect(await requestsMoved()).toEqual([
      `db_fallback/error:${2 * (THRESHOLD - 1)}`,
      'index/ok:1',
    ]);
  });

  it('a database failure after the index answered never trips it', async () => {
    h.listStoreListingsBySlugs.mockRejectedValue(new Error('db'));
    await searches(THRESHOLD * 2);
    // Every search still reached the index.
    expect(fetchCalls).toHaveLength(THRESHOLD * 2);
    // And the index answering is what counts: between two runs of index failures one short of the
    // threshold, it resets the count even though the database then failed the request.
    failing();
    await searches(THRESHOLD - 1);
    healthy();
    await search();
    failing();
    await searches(THRESHOLD - 1);
    expect(fetchCalls).toHaveLength(THRESHOLD * 2 + 2 * (THRESHOLD - 1) + 1);
    expect(breakerLines()).toEqual([]);
    expect(await requestsMoved()).toEqual([
      `db_fallback/db_error:${THRESHOLD * 2 + 1}`,
      `db_fallback/error:${2 * (THRESHOLD - 1)}`,
    ]);
  });

  it('stays open for the cooldown, then one probe that succeeds closes it', async () => {
    await trip();
    healthy();
    vi.setSystemTime(T0 + COOLDOWN_MS - 1);
    await search();
    expect(fetchCalls).toHaveLength(THRESHOLD);

    // The cooldown is over: the next search is the probe; the ones while it is in flight are not.
    vi.setSystemTime(T0 + COOLDOWN_MS);
    // The probe's answer is held until released; any other call fails at once, so a breaker that
    // let a second search through shows as an extra call rather than a hung test.
    let answer: () => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      answer = () => resolve(Response.json({ results: [indexed(DELTA), indexed(ALPHA)] }));
    });
    let calls = 0;
    stubIndex(() => (calls++ === 0 ? held : new Response('{"error":"internal"}', { status: 500 })));
    const probe = search();
    await settle();
    const during = await search();
    expect(during.search).toBeUndefined();
    expect(fetchCalls).toHaveLength(THRESHOLD + 1);
    expect(await breakerState()).toBe(1);
    answer();
    expect((await probe).search).toBe('index');

    // Closed again: every search calls the index.
    healthy();
    await searches(2);
    expect(fetchCalls).toHaveLength(THRESHOLD + 3);
    expect(await breakerState()).toBe(0);
    expect(breakerLines()).toEqual([
      `app-index-search: breaker closed->open consecutive_failures=${THRESHOLD} reason=error`,
      'app-index-search: breaker open->half_open cooldown elapsed',
      'app-index-search: breaker half_open->closed probe succeeded',
    ]);
    expect(await requestsMoved()).toEqual([
      'db_fallback/breaker_open:2',
      `db_fallback/error:${THRESHOLD}`,
      'index/ok:3',
    ]);
  });

  it('a failed probe re-opens it for another full cooldown', async () => {
    await trip();
    vi.setSystemTime(T0 + COOLDOWN_MS);
    await search(); // the probe, still failing
    expect(fetchCalls).toHaveLength(THRESHOLD + 1);

    // Re-opened at the probe: the cooldown counts from there, not from the first open.
    healthy();
    vi.setSystemTime(T0 + 2 * COOLDOWN_MS - 1);
    await search();
    expect(fetchCalls).toHaveLength(THRESHOLD + 1);
    vi.setSystemTime(T0 + 2 * COOLDOWN_MS);
    expect((await search()).search).toBe('index');
    expect(fetchCalls).toHaveLength(THRESHOLD + 2);
    expect(breakerLines()).toEqual([
      `app-index-search: breaker closed->open consecutive_failures=${THRESHOLD} reason=error`,
      'app-index-search: breaker open->half_open cooldown elapsed',
      'app-index-search: breaker half_open->open probe failed reason=error',
      'app-index-search: breaker open->half_open cooldown elapsed',
      'app-index-search: breaker half_open->closed probe succeeded',
    ]);
  });

  it('a viewer the index never answers neither trips it nor is counted as breaker_open', async () => {
    await trip();
    await listStoreGrid(INPUT, { ...SFW_OPTS, floor: 'moderators' }, { indexSearch: true });
    expect(await requestsMoved()).toEqual([
      `db_fallback/error:${THRESHOLD}`,
      'db_fallback/unsupported_viewer:1',
    ]);
  });
});
