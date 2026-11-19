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
 * `app-index-search: q_len=… index=N db=M overlap=K dropped=D source=index|db_fallback reason=…
 * field_diffs=name:…,tagline:…,iconUrl:…,rating:… field_expected=iconUrl:…,rating:…`.
 * The database side is the slugs of that first page whose name or tagline contains the query, the
 * client-side rule, so for a catalog larger than one page it undercounts.
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

  let indexed: IndexResult[];
  try {
    indexed = await fetchIndexResults(query, input);
  } catch (err) {
    return fallBack(dbPage, query, err instanceof IndexUnavailable ? err.reason : 'error');
  }
  const slugs = indexed.map((r) => r.slug);
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
    fields: compareIndexFields(indexed, cards, { redCapable: opts.redCapable ?? false }),
  });
  return { items: cards, nextCursor: undefined, search: 'index' };
}

async function fallBack(
  dbPage: Promise<StoreGridPage>,
  query: string,
  reason: AppIndexSearchReason
): Promise<StoreGridPage> {
  const db = await dbPage;
  report({
    query,
    source: 'db_fallback',
    reason,
    served: null,
    indexed: 0,
    db: db.items,
    fields: null,
  });
  return db;
}

/** The index's results, in its order. Throws IndexUnavailable naming why it could not. */
async function fetchIndexResults(
  query: string,
  input: ListAppListingsInput
): Promise<IndexResult[]> {
  const params = new URLSearchParams({ q: query, limit: String(input.limit) });
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
  /** The field comparison, or null on the database path. */
  fields: ReturnType<typeof compareIndexFields> | null;
}) {
  recordAppIndexSearch(r.source, r.reason);
  if (r.fields) {
    for (const f of APP_INDEX_COMPARED_FIELDS) recordAppIndexSearchFieldDiffs(f, r.fields.diffs[f]);
  }
  const fieldDiffs = r.fields ? formatCounts(r.fields.diffs, APP_INDEX_COMPARED_FIELDS) : 'none';
  const fieldExpected = r.fields ? formatCounts(r.fields.expected, ['iconUrl', 'rating']) : 'none';
  const dbSlugs = r.db ? matchingSlugs(r.db, r.query) : null;
  const served = r.served ?? [];
  const overlap = dbSlugs ? served.filter((c) => dbSlugs.has(c.slug)).length : 0;
  console.info(
    `app-index-search: q_len=${r.query.length} index=${served.length} db=${
      dbSlugs ? dbSlugs.size : -1
    } overlap=${overlap} dropped=${Math.max(0, r.indexed - served.length)} source=${
      r.source
    } reason=${r.reason} field_diffs=${fieldDiffs} field_expected=${fieldExpected}`
  );
}
