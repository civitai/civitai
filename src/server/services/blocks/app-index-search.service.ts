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
 * A flagged request is sent to the index only when the index can answer it without dropping a
 * listing the database grid would show this viewer: an SFW-only viewer on the `public` audience
 * floor, a grid without sub-listing cards, and, for the `public-external` store scope (off-site
 * listings only), the index asked for off-site apps only. Everything else is today's database
 * path, unchanged: the flag off, no query, a mature viewer, a tester or moderator floor, sub-listing
 * cards, a developer-filtered or paged request, APP_INDEX_URL unset, and any index failure (a timeout of
 * APP_INDEX_SEARCH_TIMEOUT_MS, a non-2xx answer such as 503 before the index is ready, or a body
 * that is not a search response). On the database path the client filters by the query itself,
 * as it always has; a page answered by the index says so (`search: 'index'`), so the client does
 * not filter it again.
 *
 * Every routed request logs one line (no query text, no user):
 * `app-index-search: q_len=… index=N db=M overlap=K dropped=D source=index|db_fallback reason=…
 * field_diffs=name:…,tagline:…,iconUrl:…,rating:… field_expected=iconUrl:…,rating:…`.
 * `db` and `overlap` compare against the database page the request would have served: the slugs
 * of that first page whose name or tagline contains the query (the client-side rule, so for a
 * catalog larger than one page it undercounts). An index answer reads that page only for a sampled
 * fraction (APP_INDEX_SEARCH_COMPARE_SAMPLE), off the response path; unsampled, the two are
 * `none`. `searchThroughIndex` states the latency shape.
 *
 * Users only ever see database-hydrated cards. The index's own copy of each field the store card
 * shows (name, tagline, iconUrl, rating) is compared with the card the database hydrated for the
 * same slug (`compareIndexFields`), so a stale or wrong registry field is counted
 * (`civitai_app_index_search_field_diffs_total{field}`) without ever reaching a user. On the
 * database path there is nothing to compare: `field_diffs=none field_expected=none`.
 */
import * as z from 'zod';
import { env } from '~/env/server';
import {
  APP_INDEX_COMPARED_FIELDS,
  recordAppIndexSearch,
  recordAppIndexSearchFieldDiffs,
  type AppIndexComparedField,
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
import { isOffsiteContentRating } from '~/shared/constants/browsingLevel.constants';

/** How long a store search waits for the index before serving the database path. */
export const APP_INDEX_SEARCH_TIMEOUT_MS = 300;

export type StoreGridPage = {
  items: StoreGridItem[];
  nextCursor?: string;
  /** Set when the index answered the query: the items are already the search's results. */
  search?: 'index';
  /**
   * With the flag on, whether this viewer's searches can go to the index (`viewerNotRoutable`).
   * The client sends its search text as `query` only once a page has said true, so a viewer the
   * index never answers keeps today's request and client-side filtering. Absent with the flag off.
   */
  indexSearchRoutable?: boolean;
};

// The index answers every field as a string, '' for none.
const indexResultSchema = z.object({
  slug: z.string().min(1),
  name: z.string(),
  tagline: z.string(),
  iconUrl: z.string(),
  rating: z.string(),
});
export type IndexResult = z.infer<typeof indexResultSchema>;
const indexResponseSchema = z.object({ results: z.array(indexResultSchema) });

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
  if (!indexSearch) return reads.listAvailableListings(input, opts);
  const indexSearchRoutable = viewerNotRoutable(opts) === null;
  const query = input.query?.trim() ?? '';
  const page =
    query === ''
      ? await reads.listAvailableListings(input, opts)
      : await searchThroughIndex(input, query, opts, reads);
  return { ...page, indexSearchRoutable };
}

/**
 * Why this viewer's searches cannot go to the index, or null when they can. Each condition is one
 * where the index could leave out a listing the database grid shows this viewer.
 */
export function viewerNotRoutable(opts: ListAvailableListingsOpts): AppIndexSearchReason | null {
  if (!env.APP_INDEX_URL) return 'no_url';
  const mature = matureRatingsAllowed(opts.redCapable ?? false, opts.viewerBrowsingLevel);
  // The index holds the anonymous registry audience: SFW listings only.
  if (mature.r || mature.x || mature.xxx) return 'mature_viewer';
  // A tester or moderator floor admits listings that are not public.
  if ((opts.floor ?? 'public') !== 'public') return 'unsupported_viewer';
  // Sub-listing cards are not apps; the index has none.
  if (opts.includeSubListings === true) return 'sub_listings';
  return null;
}

/** Why a flagged request is not sent to the index, or null when it is. */
function notRoutable(
  input: ListAppListingsInput,
  opts: ListAvailableListingsOpts
): AppIndexSearchReason | null {
  const viewer = viewerNotRoutable(opts);
  if (viewer) return viewer;
  // The index answers one page of the store grid: no developer filter, no store cursor.
  if (input.userId != null || input.cursor) return 'unsupported_input';
  return null;
}

/**
 * The `kind` the index is asked for: off-site only under the `public-external` scope, which shows
 * nothing else (so the index's `limit` is not spent on apps the store gates would drop), else the
 * request's own.
 */
function indexKind(input: ListAppListingsInput, opts: ListAvailableListingsOpts): string | null {
  if (opts.scope === 'public-external') return 'offsite';
  return input.kind === 'all' ? null : input.kind;
}

async function searchThroughIndex(
  input: ListAppListingsInput,
  query: string,
  opts: ListAvailableListingsOpts,
  reads: StoreGridReads
): Promise<StoreGridPage> {
  const skip = notRoutable(input, opts);
  if (skip) return fallBack(reads.listAvailableListings(input, opts), query, skip);

  // The latency shape. A sampled request (APP_INDEX_SEARCH_COMPARE_SAMPLE) reads the database page
  // at once, beside the index call: it is the comparison's other side, and, if the index fails,
  // the fallback already in flight, so that fallback costs max(index, database), never the sum.
  // When the index answers, the response never waits for that read; the comparison is logged when
  // it settles. An unsampled request reads the database only if the index fails, so its fallback
  // costs the index's failure (at most APP_INDEX_SEARCH_TIMEOUT_MS) plus the database read, and a
  // successful one reads no grid page at all.
  const sampled = Math.random() < env.APP_INDEX_SEARCH_COMPARE_SAMPLE;
  const early = sampled ? reads.listAvailableListings(input, opts) : null;
  // Handled where it is used; this only keeps an early rejection from being reported as
  // unhandled while the index call is in flight.
  early?.catch(() => undefined);
  const dbPage = () => early ?? reads.listAvailableListings(input, opts);

  let indexed: IndexResult[];
  try {
    indexed = await fetchIndexResults(query, input, indexKind(input, opts));
  } catch (err) {
    return fallBack(dbPage(), query, err instanceof IndexUnavailable ? err.reason : 'error');
  }
  const slugs = indexed.map((r) => r.slug);
  let cards: ListingCard[];
  try {
    cards = await reads.listStoreListingsBySlugs(slugs, input, opts);
  } catch {
    return fallBack(dbPage(), query, 'error');
  }
  const r: Report = {
    query,
    source: 'index',
    reason: 'ok',
    served: cards,
    indexed: slugs.length,
    db: 'unsampled',
    fields: compareIndexFields(indexed, cards, { redCapable: opts.redCapable ?? false }),
  };
  recordCounters(r);
  if (early) {
    // Fire and forget, with its own catch: the response has already been decided.
    void early
      .then(
        (db) => logLine({ ...r, db: db.items }),
        () => logLine({ ...r, db: undefined })
      )
      .catch(() => undefined);
  } else {
    logLine(r);
  }
  return { items: cards, nextCursor: undefined, search: 'index' };
}

async function fallBack(
  dbPage: Promise<StoreGridPage>,
  query: string,
  reason: AppIndexSearchReason
): Promise<StoreGridPage> {
  const db = await dbPage;
  const r: Report = {
    query,
    source: 'db_fallback',
    reason,
    served: null,
    indexed: 0,
    db: db.items,
    fields: null,
  };
  recordCounters(r);
  logLine(r);
  return db;
}

/** The index's results, in its order. Throws IndexUnavailable naming why it could not. */
async function fetchIndexResults(
  query: string,
  input: ListAppListingsInput,
  kind: string | null
): Promise<IndexResult[]> {
  const params = new URLSearchParams({ q: query, limit: String(input.limit) });
  if (kind) params.set('kind', kind);
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
  return parsed.data.results;
}

type FieldCounts = Record<AppIndexComparedField, number>;
const zeroCounts = (): FieldCounts => ({ name: 0, tagline: 0, iconUrl: 0, rating: 0 });

/**
 * Per field, how many served cards differ from the index's copy of the same slug: `diffs` have no
 * known cause, `expected` do. The known causes, both from how each side gates what it publishes:
 *   - iconUrl: the store card gates the icon at the viewer's level AND the listing's rating, the
 *     registry at the listing's rating alone, so the card can have no icon where the index has
 *     one. On a red-capable request the card may also show the red-host icon override, which the
 *     registry never publishes. (Both build the url the same way, `gatedListingIconUrl`, so any
 *     other icon difference is a diff, including an index icon the card does not have.)
 *   - rating: the card shows the listing's own rating; the registry publishes it only when it is a
 *     known rating, and otherwise the backing block's. A card whose rating is not a known one may
 *     therefore differ.
 * Text fields compare exactly, a missing tagline as ''. Ratings compare case-insensitively.
 */
export function compareIndexFields(
  indexed: readonly IndexResult[],
  cards: readonly ListingCard[],
  { redCapable }: { redCapable: boolean }
): { diffs: FieldCounts; expected: FieldCounts } {
  const diffs = zeroCounts();
  const expected = zeroCounts();
  const bySlug = new Map(indexed.map((r) => [r.slug, r] as const));
  for (const card of cards) {
    const idx = bySlug.get(card.slug);
    if (!idx) continue;
    if (idx.name !== card.name) diffs.name++;
    if (idx.tagline !== (card.tagline ?? '')) diffs.tagline++;

    const cardIcon = card.iconUrl ?? '';
    if (idx.iconUrl !== cardIcon) {
      const gatedByViewer = cardIcon === '' && idx.iconUrl !== '';
      const redOverride = redCapable && cardIcon !== '' && idx.iconUrl !== '';
      if (gatedByViewer || redOverride) expected.iconUrl++;
      else diffs.iconUrl++;
    }

    const cardRating = (card.contentRating ?? '').toLowerCase();
    if (idx.rating.toLowerCase() !== cardRating) {
      if (isOffsiteContentRating(cardRating)) diffs.rating++;
      else expected.rating++;
    }
  }
  return { diffs, expected };
}

const formatCounts = (c: FieldCounts, fields: readonly AppIndexComparedField[]) =>
  fields.map((f) => `${f}:${c[f]}`).join(',');

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

type Report = {
  query: string;
  source: AppIndexSearchSource;
  reason: AppIndexSearchReason;
  /** What the index path served, or null on the database path. */
  served: ListingCard[] | null;
  /** How many slugs the index returned (before the store gates). */
  indexed: number;
  /** The database page; undefined when it failed, 'unsampled' when it was not read. */
  db: StoreGridItem[] | undefined | 'unsampled';
  /** The field comparison, or null on the database path. */
  fields: ReturnType<typeof compareIndexFields> | null;
};

function recordCounters(r: Report) {
  recordAppIndexSearch(r.source, r.reason);
  if (r.fields) {
    for (const f of APP_INDEX_COMPARED_FIELDS) recordAppIndexSearchFieldDiffs(f, r.fields.diffs[f]);
  }
}

/** The comparison log line: counts only, never the query text or a value. */
function logLine(r: Report) {
  const fieldDiffs = r.fields ? formatCounts(r.fields.diffs, APP_INDEX_COMPARED_FIELDS) : 'none';
  const fieldExpected = r.fields ? formatCounts(r.fields.expected, ['iconUrl', 'rating']) : 'none';
  const served = r.served ?? [];
  let db = 'none';
  let overlap = 'none';
  if (r.db === undefined) {
    db = '-1';
    overlap = '0';
  } else if (r.db !== 'unsampled') {
    const dbSlugs = matchingSlugs(r.db, r.query);
    db = String(dbSlugs.size);
    overlap = String(served.filter((c) => dbSlugs.has(c.slug)).length);
  }
  console.info(
    `app-index-search: q_len=${r.query.length} index=${served.length} db=${db} overlap=${overlap} ` +
      `dropped=${Math.max(0, r.indexed - served.length)} source=${r.source} reason=${r.reason} ` +
      `field_diffs=${fieldDiffs} field_expected=${fieldExpected}`
  );
}
