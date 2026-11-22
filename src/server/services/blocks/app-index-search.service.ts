/**
 * `/apps` store text search through the app index (`apps/app-index-go`), behind the
 * `app-index-search` flag.
 *
 * Every index call names the viewer's mature ratings (`indexMature`, the index's `mature`
 * parameter), so the index answers only apps the viewer's level admits; without it the index
 * answers SFW apps only. The index still subscribes as the anonymous audience and so holds only SFW
 * apps, so a viewer whose level admits a mature rating is not routed to it yet
 * (`viewerNotRoutable`): it would miss that viewer's mature apps. It answers slugs; users only ever
 * see cards the database hydrated for those slugs through the store's own gates. Sub-listing cards are not in the index: with them on
 * the page, an index answer adds the matching ones from the database page (`withSubListingCards`).
 * Any index failure serves the database path, and a run of them opens a per-process breaker
 * (`IndexBreaker`) that keeps searches off the index for a cooldown.
 */
import * as z from 'zod';
import { env } from '~/env/server';
import {
  APP_INDEX_COMPARED_FIELDS,
  recordAppIndexBreakerTransition,
  recordAppIndexSearch,
  recordAppIndexSearchFieldDiffs,
  type AppIndexBreakerState,
  type AppIndexComparedField,
  type AppIndexSearchReason,
  type AppIndexSearchSource,
} from '~/server/prom/app-index-search.metrics';
import type {
  ListAppListingsInput,
  ListingCard,
  StoreGridItem,
  SubListingCard,
} from '~/server/schema/blocks/app-listing-read.schema';
import { matureRatingsAllowed } from '~/server/services/blocks/app-listing-store-gate';
import type { ListAvailableListingsOpts } from '~/server/services/blocks/app-listing.service';
import { outboundFetch } from '~/server/utils/fetch-timeout';
import { isSubListingCard } from '~/shared/constants/app-sub-listing.constants';
import { isOffsiteContentRating } from '~/shared/constants/browsingLevel.constants';
import { storeGridCardMatches } from '~/shared/utils/store-grid-search';

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
  /**
   * The page of a request the index does not search (no text query, or the index switch off):
   * `listAvailableListings` when absent. The store grid passes the listings read model's serving
   * read (`serveListingPage`). A search's own database reads, its fallbacks included, never use it.
   */
  gridPage?: (
    input: ListAppListingsInput,
    opts: ListAvailableListingsOpts
  ) => Promise<StoreGridPage>;
};

// Imported on use: the listing service is a large module the routing does not need until it reads.
const listingService = () => import('~/server/services/blocks/app-listing.service');
export const DB_READS: StoreGridReads = {
  listAvailableListings: async (input, opts) =>
    (await listingService()).listAvailableListings(input, opts),
  listStoreListingsBySlugs: async (slugs, input, opts) =>
    (await listingService()).listStoreListingsBySlugs(slugs, input, opts),
};

/** Why an app index call gave no usable answer: the outcomes every caller of it counts. */
export type AppIndexFetchFailure = 'timeout' | 'not_ready' | 'error' | 'bad_response';

/** Thrown by {@link fetchAppIndexJson}, naming why the call gave no usable answer. */
export class AppIndexUnavailable extends Error {
  constructor(readonly reason: AppIndexFetchFailure) {
    super(reason);
  }
}

/** Whether `err` is a fetch or body read cut off by its timeout (or aborted). */
export function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * One app index call (`apps/app-index-go`), classified: the body parsed by `schema`, or
 * {@link AppIndexUnavailable} naming why not (a timeout or abort, a 503 while the index is not
 * ready, any other failure or non-2xx status, a 2xx body that does not parse). `fetch` is the
 * caller's (`outboundFetch` in production).
 */
export async function fetchAppIndexJson<T>(
  fetch: (
    url: string,
    init: { headers: Record<string, string>; timeoutMs: number }
  ) => Promise<Response>,
  url: string,
  init: { headers: Record<string, string>; timeoutMs: number },
  schema: z.ZodType<T>
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new AppIndexUnavailable(isTimeout(err) ? 'timeout' : 'error');
  }
  if (res.status === 503) throw new AppIndexUnavailable('not_ready');
  if (!res.ok) throw new AppIndexUnavailable('error');
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new AppIndexUnavailable(isTimeout(err) ? 'timeout' : 'bad_response');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AppIndexUnavailable('bad_response');
  return parsed.data;
}

/**
 * A per-process circuit breaker around the index call.
 *
 * Closed, every routable search calls the index. After `threshold` consecutive index failures
 * (timeouts, 503s, other errors, bad bodies) it opens: searches serve the database path without
 * calling the index (`breaker_open`). Once `cooldownMs` has passed since it opened, the next
 * search is a single probe (half-open) while the others stay on the database path; the probe's
 * success closes the breaker, its failure re-opens it for another cooldown. Any index success
 * resets the count. Only the index call's own outcome counts: a database read failing after the
 * index answered (`db_error`) is a success for the breaker.
 *
 * Consecutive failures, not an error rate over a window: one success proves the index is
 * serving, and the count needs no window sized to a traffic level that differs per process
 * and per rollout step.
 */
export class IndexBreaker {
  private state: AppIndexBreakerState = 'closed';
  private failures = 0;
  /** When the breaker last opened, or when the in-flight probe started (half-open). */
  private since = 0;

  constructor(
    private readonly config: () => { threshold: number; cooldownMs: number } = () => ({
      threshold: env.APP_INDEX_BREAKER_FAILURE_THRESHOLD,
      cooldownMs: env.APP_INDEX_BREAKER_COOLDOWN_MS,
    }),
    private readonly now: () => number = () => Date.now(),
    /**
     * Reports each state change. The default is the store search's gauge, counter and log line;
     * another caller of the index (the listings read-model shadow) passes its own.
     */
    private readonly report: (
      from: AppIndexBreakerState,
      to: AppIndexBreakerState,
      why: string
    ) => void = (from, to, why) => {
      recordAppIndexBreakerTransition(to);
      // No query text: the breaker never sees one.
      console.info(`app-index-search: breaker ${from}->${to} ${why}`);
    }
  ) {}

  /**
   * Whether `allow()` would refuse right now, without changing state or taking the probe: open and
   * still inside its cooldown. For a caller that has work to do before its first index call and
   * should skip that work while the breaker is open.
   */
  refusing(): boolean {
    return this.state === 'open' && this.now() - this.since < this.config().cooldownMs;
  }

  /** Whether this search may call the index. Admits the half-open probe. */
  allow(): boolean {
    if (this.state === 'closed') return true;
    // Open: the probe after the cooldown. Half-open: another probe only if the one in flight has
    // outlived a whole cooldown without reporting, which the index call's deadline should prevent.
    if (this.now() - this.since < this.config().cooldownMs) return false;
    this.since = this.now();
    this.transition('half_open', 'cooldown elapsed');
    return true;
  }

  success() {
    this.failures = 0;
    if (this.state === 'half_open') this.transition('closed', 'probe succeeded');
  }

  failure(reason: string) {
    if (this.state === 'half_open') {
      this.open(`probe failed reason=${reason}`);
      return;
    }
    if (this.state === 'open') return;
    this.failures++;
    const { threshold } = this.config();
    if (this.failures >= threshold) {
      this.open(`consecutive_failures=${this.failures} reason=${reason}`);
    }
  }

  private open(why: string) {
    this.since = this.now();
    this.failures = 0;
    this.transition('open', why);
  }

  private transition(to: AppIndexBreakerState, why: string) {
    const from = this.state;
    this.state = to;
    this.report(from, to, why);
  }
}

/** This process's breaker. */
const indexBreaker = new IndexBreaker();

/**
 * The `/apps` store grid page: through the index when `indexSearch` (the viewer's flag) is on and
 * the request carries a text query, else `reads.gridPage` (`listAvailableListings` when absent).
 */
export async function listStoreGrid(
  input: ListAppListingsInput,
  opts: ListAvailableListingsOpts,
  { indexSearch }: { indexSearch: boolean },
  reads: StoreGridReads = DB_READS,
  breaker: IndexBreaker = indexBreaker
): Promise<StoreGridPage> {
  const gridPage = reads.gridPage ?? reads.listAvailableListings;
  if (!indexSearch) return gridPage(input, opts);
  const indexSearchRoutable = viewerNotRoutable(opts) === null;
  const query = input.query?.trim() ?? '';
  const page =
    query === ''
      ? await gridPage(input, opts)
      : await searchThroughIndex(input, query, opts, reads, breaker);
  return { ...page, indexSearchRoutable };
}

/** What `appListings.listAvailable` knows about the request beyond its input. */
export type StoreGridViewer = Omit<ListAvailableListingsOpts, 'includeSubListings'> & {
  /** The viewer's feature flags (`ctx.features`). */
  features: { appStoreSubListings?: boolean; appIndexSearch?: boolean } | undefined;
};

/**
 * `listStoreGrid`'s arguments for one `appListings.listAvailable` request: the one place the
 * request's opt-ins meet the viewer's flags, so the combination is testable without the router.
 *
 * Sub-listing cards need the caller's opt-in AND the `app-store-sub-listings` flag: a
 * `ListingCard`-only caller (the related rail) must never receive a `SubListingCard` just because
 * the viewer has the flag.
 */
export function storeGridRequest(
  input: ListAppListingsInput,
  { features, ...opts }: StoreGridViewer
): [ListAvailableListingsOpts, { indexSearch: boolean }] {
  return [
    {
      ...opts,
      includeSubListings: input.includeSubListings === true && !!features?.appStoreSubListings,
    },
    { indexSearch: !!features?.appIndexSearch },
  ];
}

/**
 * Why this viewer's searches cannot go to the index, or null when they can. Each condition is one
 * where the index could leave out a listing the database grid shows this viewer.
 */
export function viewerNotRoutable(opts: ListAvailableListingsOpts): AppIndexSearchReason | null {
  if (!env.APP_INDEX_URL) return 'no_url';
  const mature = matureRatingsAllowed(opts.redCapable ?? false, opts.viewerBrowsingLevel);
  // The index holds the anonymous registry audience: SFW listings only. Its search already filters
  // by the viewer's mature ratings (`indexMature`), so this check goes once it holds mature ones.
  if (mature.r || mature.x || mature.xxx) return 'mature_viewer';
  // A tester or moderator floor admits listings that are not public.
  if ((opts.floor ?? 'public') !== 'public') return 'unsupported_viewer';
  // Sub-listing cards (`includeSubListings`) do not make a viewer unroutable: the index has none,
  // so an index answer takes them from the database page (`searchThroughIndex`).
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

/**
 * The index's `mature` parameter for this viewer: the mature ratings the database grid shows them
 * (`matureRatingsAllowed`, the same read `storeVisibleListingRowGate` filters by), as the index's
 * comma-separated list in a fixed order (so a shared cache sees one URL per set), or null for none.
 * Null is sent as no parameter, which the index answers as the SFW audience (g, pg, pg13).
 */
export function indexMature(opts: ListAvailableListingsOpts): string | null {
  const allowed = matureRatingsAllowed(opts.redCapable ?? false, opts.viewerBrowsingLevel);
  const list = (['r', 'x', 'xxx'] as const).filter((r) => allowed[r]);
  return list.length > 0 ? list.join(',') : null;
}

async function searchThroughIndex(
  input: ListAppListingsInput,
  query: string,
  opts: ListAvailableListingsOpts,
  reads: StoreGridReads,
  breaker: IndexBreaker
): Promise<StoreGridPage> {
  const skip = notRoutable(input, opts);
  if (skip) return fallBack(reads.listAvailableListings(input, opts), query, skip);
  // While open the request is exactly the unsampled database path: no index call, one read.
  if (!breaker.allow()) {
    return fallBack(reads.listAvailableListings(input, opts), query, 'breaker_open');
  }

  // The latency shape. A sampled request (APP_INDEX_SEARCH_COMPARE_SAMPLE) reads the database page
  // at once, beside the index call: it is the comparison's other side, and, if the index fails,
  // the fallback already in flight, so that fallback costs max(index, database), never the sum.
  // When the index answers, the response never waits for that read; the comparison is logged when
  // it settles. An unsampled request reads the database only if the index fails, so its fallback
  // costs the index's failure (at most APP_INDEX_SEARCH_TIMEOUT_MS) plus the database read, and a
  // successful one reads no grid page at all.
  //
  // With sub-listing cards on the page (`includeSubListings`), every request reads the database
  // page beside the index call: an index answer needs that page's sub-listing cards
  // (`withSubListingCards`), so it waits for max(index, database) rather than the sum.
  const withSubListings = opts.includeSubListings === true;
  const sampled = withSubListings || Math.random() < env.APP_INDEX_SEARCH_COMPARE_SAMPLE;
  const early = sampled ? reads.listAvailableListings(input, opts) : null;
  // Handled where it is used; this only keeps an early rejection from being reported as
  // unhandled while the index call is in flight.
  early?.catch(() => undefined);
  const dbPage = () => early ?? reads.listAvailableListings(input, opts);

  let indexed: IndexResult[];
  try {
    indexed = await fetchIndexResults(query, input, indexKind(input, opts), indexMature(opts));
  } catch (err) {
    const reason = err instanceof AppIndexUnavailable ? err.reason : 'error';
    breaker.failure(reason);
    return fallBack(dbPage(), query, reason);
  }
  breaker.success();
  // From here on the index has answered: a failure is the database's (`db_error`).
  const slugs = indexed.map((r) => r.slug);
  let cards: ListingCard[];
  try {
    cards = await reads.listStoreListingsBySlugs(slugs, input, opts);
  } catch {
    return fallBack(dbPage(), query, 'db_error');
  }
  let items: StoreGridItem[] = cards;
  if (early && withSubListings) {
    let db: StoreGridPage;
    try {
      db = await early;
    } catch {
      // The database page this answer needs failed. Serving the index's apps alone would hide
      // every sub-listing card as if none matched, so the request is the database path's: one
      // fresh read of the full page, whose own failure is the request's error, as with the flag off.
      return fallBack(reads.listAvailableListings(input, opts), query, 'db_error');
    }
    items = withSubListingCards(cards, db.items, query);
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
  // An index answer is one page with no cursor to a next one: the index's apps in its relevance
  // order, then any sub-listing cards (`withSubListingCards`).
  return { items, nextCursor: undefined, search: 'index' };
}

/**
 * An index answer's page with sub-listing cards: the index's app cards, in its relevance order,
 * then the sub-listing cards of the database page `dbItems` that match `query`, in that page's
 * order.
 *
 * The sub-listing cards are exactly the ones the database path shows this viewer for the same
 * search on its first page: the same read (`listAvailableListings`, with every gate it applies)
 * narrowed by the same rule the client filters that page with (`storeGridCardMatches`). Apps come
 * first because they are the index's ranked answer; relevance and the grid's sort key share no
 * scale, so the two lists are not interleaved.
 */
function withSubListingCards(
  cards: ListingCard[],
  dbItems: readonly StoreGridItem[],
  query: string
): StoreGridItem[] {
  const subListings = dbItems.filter(
    (item): item is SubListingCard => isSubListingCard(item) && storeGridCardMatches(item, query)
  );
  return [...cards, ...subListings];
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

/** The index's results, in its order. Throws AppIndexUnavailable naming why it could not. */
async function fetchIndexResults(
  query: string,
  input: ListAppListingsInput,
  kind: string | null,
  mature: string | null
): Promise<IndexResult[]> {
  const params = new URLSearchParams({ q: query, limit: String(input.limit) });
  if (kind) params.set('kind', kind);
  if (input.category) params.set('category', input.category);
  if (mature) params.set('mature', mature);
  const base = (env.APP_INDEX_URL as string).replace(/\/+$/, '');
  const { results } = await fetchAppIndexJson(
    outboundFetch,
    `${base}/search?${params}`,
    { headers: { accept: 'application/json' }, timeoutMs: APP_INDEX_SEARCH_TIMEOUT_MS },
    indexResponseSchema
  );
  return results;
}

type FieldCounts = Record<AppIndexComparedField, number>;
const zeroCounts = (): FieldCounts => ({ name: 0, tagline: 0, iconUrl: 0, rating: 0 });

/**
 * Per field, how many served cards differ from the index's copy of the same slug: `diffs` have no
 * known cause, `expected` do. The known causes, both from how each side gates what it publishes:
 *   - iconUrl: the store card gates the icon at the viewer's level AND the listing's rating, the
 *     registry at the listing's rating alone, so the card can have no icon where the index has
 *     one (expected). On a red-capable request the card may also show the red-host icon override,
 *     which the registry never publishes (expected). Both build the url the same way
 *     (`gatedListingIconUrl`), so every other icon difference is a diff: a card icon the index
 *     does not have, or two different icons off a red-capable request.
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

/**
 * The slugs of a page's listing cards that match the query (the client rule). Listing cards only,
 * so the comparison sets the index's apps against the database's apps: sub-listing cards are
 * never in the index, and the ones an answer carries come from this same page.
 */
function matchingSlugs(items: StoreGridItem[], query: string): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    if (isSubListingCard(item)) continue;
    if (storeGridCardMatches(item, query)) out.add(item.slug);
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
