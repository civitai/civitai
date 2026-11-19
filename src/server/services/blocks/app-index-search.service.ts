/**
 * `/apps` store text search through the app index (`apps/app-index-go`), behind the
 * `app-index-search` Flipt flag.
 *
 * The app index follows the registry's app stream into its own database and answers
 * `GET /search`. With the flag on for the viewer, a store request that carries a text `query`
 * asks the index for the matching slugs (relevance order), then hydrates those slugs into store
 * cards from the database through the store's own gates (`listStoreListingsBySlugs`), keeping
 * the index's order. The index holds what an anonymous registry subscriber may read, the SFW
 * audience, so a viewer who may see r/x listings is never routed to it.
 *
 * Everything else is today's database path, unchanged: the flag off, no query, a mature viewer,
 * a developer-filtered or paged request, APP_INDEX_URL unset, and any index failure (a timeout of
 * APP_INDEX_SEARCH_TIMEOUT_MS, a non-2xx answer such as 503 before the index is ready, or a body
 * that is not a search response). On the database path the client filters by the query itself,
 * as it always has; a page answered by the index says so (`search: 'index'`), so the client does
 * not filter it again.
 *
 * Every flagged request also reads the database page it would have served, which is the
 * fallback, and logs a comparison of the two slug sets (no query text, no user):
 * `app-index-search: q_len=… index=N db=M overlap=K dropped=D source=index|db_fallback reason=…`.
 * The database side is the slugs of that first page whose name or tagline contains the query, the
 * client-side rule, so for a catalog larger than one page it undercounts.
 */
import * as z from 'zod';
import { env } from '~/env/server';
import {
  recordAppIndexSearch,
  type AppIndexSearchReason,
  type AppIndexSearchSource,
} from '~/server/prom/app-index-search.metrics';
import type {
  ListAppListingsInput,
  ListingCard,
  StoreGridItem,
} from '~/server/schema/blocks/app-listing-read.schema';
import { matureRatingsAllowed } from '~/server/services/blocks/app-listing-store-gate';
import type { ListAvailableListingsOpts } from '~/server/services/blocks/app-listing.service';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';

/** How long a store search waits for the index before serving the database path. */
export const APP_INDEX_SEARCH_TIMEOUT_MS = 300;

export type StoreGridPage = {
  items: StoreGridItem[];
  nextCursor?: string;
  /** Set when the index answered the query: the items are already the search's results. */
  search?: 'index';
};

const indexResponseSchema = z.object({
  results: z.array(z.object({ slug: z.string().min(1) })),
  next: z.string().nullable(),
});

/** The two database reads this module composes; passed in so the routing is testable alone. */
export type StoreGridReads = {
  listAvailableListings: (
    input: ListAppListingsInput,
    opts: ListAvailableListingsOpts
  ) => Promise<StoreGridPage>;
  listStoreListingsBySlugs: (
    slugs: string[],
    input: ListAppListingsInput,
    opts: ListAvailableListingsOpts
  ) => Promise<ListingCard[]>;
};

// Imported on use: the listing service is a large module the routing does not need until it reads.
const listingService = () => import('~/server/services/blocks/app-listing.service');
const DB_READS: StoreGridReads = {
  listAvailableListings: async (input, opts) =>
    (await listingService()).listAvailableListings(input, opts),
  listStoreListingsBySlugs: async (slugs, input, opts) =>
    (await listingService()).listStoreListingsBySlugs(slugs, input, opts),
};

class IndexUnavailable extends Error {
  constructor(readonly reason: AppIndexSearchReason) {
    super(reason);
  }
}

/**
 * The `/apps` store grid page: through the index when `indexSearch` (the viewer's flag) is on and
 * the request carries a text query, else `listAvailableListings` exactly as before.
 */
export async function listStoreGrid(
  input: ListAppListingsInput,
  opts: ListAvailableListingsOpts,
  { indexSearch }: { indexSearch: boolean },
  reads: StoreGridReads = DB_READS
): Promise<StoreGridPage> {
  const query = input.query?.trim() ?? '';
  if (!indexSearch || query === '') return reads.listAvailableListings(input, opts);
  return searchThroughIndex(input, query, opts, reads);
}

/** Why a flagged request is not sent to the index, or null when it is. */
function notRoutable(
  input: ListAppListingsInput,
  opts: ListAvailableListingsOpts
): AppIndexSearchReason | null {
  if (!env.APP_INDEX_URL) return 'no_url';
  const mature = matureRatingsAllowed(opts.redCapable ?? false, opts.viewerBrowsingLevel);
  if (mature.r || mature.x || mature.xxx) return 'mature_viewer';
  // The index answers one page of the store grid: no developer filter, no store cursor.
  if (input.userId != null || input.cursor) return 'unsupported_input';
  return null;
}

async function searchThroughIndex(
  input: ListAppListingsInput,
  query: string,
  opts: ListAvailableListingsOpts,
  reads: StoreGridReads
): Promise<StoreGridPage> {
  // Started at once: it is the fallback, and the comparison's other side.
  const dbPage = reads.listAvailableListings(input, opts);
  // Handled where it is awaited; this only keeps an early rejection from being reported as
  // unhandled while the index call is in flight.
  dbPage.catch(() => undefined);
  const skip = notRoutable(input, opts);
  if (skip) return fallBack(dbPage, query, skip);

  let slugs: string[];
  try {
    slugs = await fetchIndexSlugs(query, input);
  } catch (err) {
    return fallBack(dbPage, query, err instanceof IndexUnavailable ? err.reason : 'error');
  }
  let cards: ListingCard[];
  try {
    cards = await reads.listStoreListingsBySlugs(slugs, input, opts);
  } catch {
    return fallBack(dbPage, query, 'error');
  }
  const db = await dbPage.catch(() => null);
  report({
    query,
    source: 'index',
    reason: 'ok',
    served: cards,
    indexed: slugs.length,
    db: db?.items,
  });
  return { items: cards, nextCursor: undefined, search: 'index' };
}

async function fallBack(
  dbPage: Promise<StoreGridPage>,
  query: string,
  reason: AppIndexSearchReason
): Promise<StoreGridPage> {
  const db = await dbPage;
  report({ query, source: 'db_fallback', reason, served: null, indexed: 0, db: db.items });
  return db;
}

/** The slugs the index matches, in its order. Throws IndexUnavailable naming why it could not. */
async function fetchIndexSlugs(query: string, input: ListAppListingsInput): Promise<string[]> {
  const params = new URLSearchParams({ q: query, sort: 'relevance', limit: String(input.limit) });
  if (input.kind !== 'all') params.set('kind', input.kind);
  if (input.category) params.set('category', input.category);
  const base = (env.APP_INDEX_URL as string).replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/search?${params}`, {
      headers: { accept: 'application/json' },
      // Dropped only by the outbound-fetch-timeouts-off switch (fetch-timeout.ts).
      signal: fetchTimeoutSignal(APP_INDEX_SEARCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new IndexUnavailable(isTimeout(err) ? 'timeout' : 'error');
  }
  if (res.status === 503) throw new IndexUnavailable('not_ready');
  if (!res.ok) throw new IndexUnavailable('error');
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new IndexUnavailable(isTimeout(err) ? 'timeout' : 'bad_response');
  }
  const parsed = indexResponseSchema.safeParse(body);
  if (!parsed.success) throw new IndexUnavailable('bad_response');
  return parsed.data.results.map((r) => r.slug);
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** The slugs of a page's listing cards whose name or tagline contains the query (the client rule). */
function matchingSlugs(items: StoreGridItem[], query: string): Set<string> {
  const q = query.toLowerCase();
  const out = new Set<string>();
  for (const item of items) {
    if (!('slug' in item)) continue;
    if (item.name.toLowerCase().includes(q) || (item.tagline ?? '').toLowerCase().includes(q)) {
      out.add(item.slug);
    }
  }
  return out;
}

function report(r: {
  query: string;
  source: AppIndexSearchSource;
  reason: AppIndexSearchReason;
  /** What the index path served, or null on the database path. */
  served: ListingCard[] | null;
  /** How many slugs the index returned (before the store gates). */
  indexed: number;
  /** The database page, or undefined when it failed. */
  db: StoreGridItem[] | undefined;
}) {
  recordAppIndexSearch(r.source, r.reason);
  const dbSlugs = r.db ? matchingSlugs(r.db, r.query) : null;
  const served = r.served ?? [];
  const overlap = dbSlugs ? served.filter((c) => dbSlugs.has(c.slug)).length : 0;
  console.info(
    `app-index-search: q_len=${r.query.length} index=${served.length} db=${
      dbSlugs ? dbSlugs.size : -1
    } overlap=${overlap} dropped=${Math.max(0, r.indexed - served.length)} source=${
      r.source
    } reason=${r.reason}`
  );
}
