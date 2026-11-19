import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type {
  ListAppListingsInput,
  ListingCard,
  StoreGridItem,
} from '~/server/schema/blocks/app-listing-read.schema';
import { NsfwLevel } from '~/server/common/enums';
import type { AppIndexSearchReason } from '~/server/prom/app-index-search.metrics';

const h = vi.hoisted(() => ({
  listAvailableListings: vi.fn(),
  listStoreListingsBySlugs: vi.fn(),
  recordAppIndexSearch: vi.fn(),
}));
vi.mock('~/server/prom/app-index-search.metrics', () => ({
  recordAppIndexSearch: h.recordAppIndexSearch,
}));

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

function card(slug: string, name: string, tagline: string | null = null): ListingCard {
  return { id: `al_${slug}`, slug, name, tagline } as unknown as ListingCard;
}

const DB_ITEMS: StoreGridItem[] = [
  card('alpha', 'Alpha Pixel'),
  card('beta', 'Beta', 'pixel tools'),
  card('gamma', 'Gamma'),
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

function stubIndex(reply: () => Promise<Response> | Response) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    fetchCalls.push(url);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return reply();
  });
}

beforeEach(() => {
  setEnv({ APP_INDEX_URL: INDEX_URL });
  fetchCalls = [];
  logLines = [];
  h.listAvailableListings.mockReset().mockResolvedValue(DB_PAGE);
  // Hydration returns the cards of the slugs it is given, in that order (the real read keeps
  // the given order: `idsInSlugOrder`).
  const bySlug = new Map<string, ListingCard>();
  for (const c of [card('alpha', 'Alpha Pixel'), card('beta', 'Beta'), card('delta', 'Delta')]) {
    bySlug.set(c.slug, c);
  }
  h.listStoreListingsBySlugs.mockReset().mockImplementation(async (slugs: string[]) =>
    slugs.flatMap((s): ListingCard[] => {
      const c = bySlug.get(s);
      return c ? [c] : [];
    })
  );
  h.recordAppIndexSearch.mockReset();
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    logLines.push(String(args[0]));
  });
  stubIndex(() =>
    Response.json({
      results: [{ slug: 'delta' }, { slug: 'beta' }, { slug: 'unlisted' }, { slug: 'alpha' }],
      next: null,
    })
  );
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
    expect(h.recordAppIndexSearch).not.toHaveBeenCalled();
    expect(logLines).toEqual([]);
  });

  it('flag on without a query: the database path, untouched', async () => {
    for (const query of [undefined, '', '   ']) {
      h.listAvailableListings.mockClear();
      const input = { ...INPUT, query };
      const res = await listStoreGrid(input, SFW_OPTS, { indexSearch: true });
      expect(res).toBe(DB_PAGE);
      expect(h.listAvailableListings.mock.calls[0][0]).toBe(input);
    }
    expect(fetchCalls).toEqual([]);
    expect(h.recordAppIndexSearch).not.toHaveBeenCalled();
  });

  it('flag on, SFW viewer: the index answers, in its order, through the store gates', async () => {
    const res = await listStoreGrid(INPUT, SFW_OPTS, { indexSearch: true });

    expect(fetchCalls).toEqual([
      'http://app-index.invalid/base/search?q=pixel&sort=relevance&limit=48&kind=onsite&category=generation',
    ]);
    // The index's order, not the database page's (alpha, beta, gamma).
    expect(h.listStoreListingsBySlugs).toHaveBeenCalledWith(
      ['delta', 'beta', 'unlisted', 'alpha'],
      INPUT,
      SFW_OPTS
    );
    expect(res).toEqual({
      items: [card('delta', 'Delta'), card('beta', 'Beta'), card('alpha', 'Alpha Pixel')],
      nextCursor: undefined,
      search: 'index',
    });
    expect(h.recordAppIndexSearch).toHaveBeenCalledWith('index', 'ok');
    // db: alpha (name) and beta (tagline) contain "pixel"; the sub-listing is not a listing.
    // overlap: beta and alpha; dropped: "unlisted", which the store gates did not return.
    expect(logLines).toEqual([
      'app-index-search: q_len=5 index=3 db=2 overlap=2 dropped=1 source=index reason=ok',
    ]);
    expect(logLines[0]).not.toContain('pixel');
  });

  type IndexReply = () => Promise<Response> | Response;
  it.each<[string, IndexReply, AppIndexSearchReason]>([
    ['a 500', () => new Response('{"error":"internal"}', { status: 500 }), 'error'],
    [
      'a 503 before the index is ready',
      () => Response.json({ error: 'not_ready' }, { status: 503 }),
      'not_ready',
    ],
    [
      'a body that is not a search response',
      () => Response.json({ results: [{ name: 'x' }] }),
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
    expect(res).toBe(DB_PAGE);
    expect(fetchCalls).toHaveLength(1);
    expect(h.listStoreListingsBySlugs).not.toHaveBeenCalled();
    expect(h.recordAppIndexSearch).toHaveBeenCalledWith('db_fallback', reason);
    expect(logLines).toEqual([
      `app-index-search: q_len=5 index=0 db=2 overlap=0 dropped=0 source=db_fallback reason=${reason}`,
    ]);
  });

  it('hydration failure: the database page', async () => {
    h.listStoreListingsBySlugs.mockRejectedValue(new Error('db'));
    const res = await listStoreGrid(INPUT, SFW_OPTS, { indexSearch: true });
    expect(res).toBe(DB_PAGE);
    expect(h.recordAppIndexSearch).toHaveBeenCalledWith('db_fallback', 'error');
  });

  it('a viewer who may see r/x listings is never sent to the index', async () => {
    for (const viewerBrowsingLevel of [NsfwLevel.R, NsfwLevel.X, NsfwLevel.PG | NsfwLevel.R]) {
      h.recordAppIndexSearch.mockClear();
      const res = await listStoreGrid(
        INPUT,
        { ...SFW_OPTS, redCapable: true, viewerBrowsingLevel },
        { indexSearch: true }
      );
      expect(res).toBe(DB_PAGE);
      expect(h.recordAppIndexSearch).toHaveBeenCalledWith('db_fallback', 'mature_viewer');
    }
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

  it.each<[string, Partial<ListAppListingsInput>, () => void, AppIndexSearchReason]>([
    ['no APP_INDEX_URL', {}, () => setEnv({ APP_INDEX_URL: undefined }), 'no_url'],
    ['a store cursor', { cursor: 'abc' }, () => undefined, 'unsupported_input'],
    ['a developer filter', { userId: 7 }, () => undefined, 'unsupported_input'],
  ])('%s: the database page', async (_, extra, setup, reason) => {
    setup();
    const res = await listStoreGrid({ ...INPUT, ...extra }, SFW_OPTS, { indexSearch: true });
    expect(res).toBe(DB_PAGE);
    expect(fetchCalls).toEqual([]);
    expect(h.recordAppIndexSearch).toHaveBeenCalledWith('db_fallback', reason);
  });

  it('times out quickly', () => {
    expect(APP_INDEX_SEARCH_TIMEOUT_MS).toBe(300);
  });
});
