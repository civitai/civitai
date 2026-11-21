/**
 * Shadow reads of the app store's listings read model (`apps/app-index-go`, `GET /listings`),
 * behind the `app-listings-read-model` Flipt flag (LISTINGS-READ-MODEL.md, "Shadow diff"; slice 4).
 *
 * The database answer is always the one served. For a sampled fraction of store grid pages
 * (`appListings.listAvailable`) and public REST list pages (`GET /api/v1/apps`), after the database
 * has answered, the same query is asked of the read model off the response path, with the viewer
 * the database read was answered for (`app-index-viewer-token.ts`), and the two pages are
 * compared by slug (the stream carries no listing id yet, slice 3b):
 *
 *   - a slug on one page only is checked against the other side by slug, with the same filters: if
 *     that side does not show the listing to this viewer at all it is a visibility mismatch
 *     (`visibility_missing` / `visibility_extra`), else the two sides only page or order it
 *     differently (an order mismatch: the database breaks ties by id, the read model by slug);
 *   - a slug on both pages has its gated media (`iconUrl`, `coverUrl`) and its other card fields
 *     compared;
 *   - the order of the slugs left once visibility mismatches are taken out, and whether each side
 *     has a next page, are compared and reported apart, so that ordering noise can never hide a gate
 *     mismatch nor be mistaken for one.
 *
 * Bounded: only a sampled fraction is shadowed (APP_LISTINGS_READ_MODEL_SHADOW_SAMPLE), at most
 * APP_LISTINGS_READ_MODEL_SHADOW_MAX_IN_FLIGHT per process at a time (the rest are dropped, never
 * queued), each read-model call within APP_LISTINGS_READ_MODEL_SHADOW_TIMEOUT_MS, and a run of
 * read-model failures opens a per-process breaker (`IndexBreaker`, with the store search's knobs)
 * that stops the shadow for a cooldown. No failure reaches the response: every one is an outcome.
 *
 * Logged: slugs and mismatch kinds (and field names), at most LOG_LINES_PER_MINUTE lines a minute
 * per process. Never a card's values, a query, or who the viewer is.
 */
import * as z from 'zod';
import { env } from '~/env/server';
import {
  READ_MODEL_MEDIA_FIELDS,
  recordReadModelBreakerTransition,
  recordReadModelComparison,
  recordReadModelShadow,
  type ReadModelComparedField,
  type ReadModelComparison,
  type ReadModelMismatchKind,
  type ReadModelShadowOutcome,
  type ReadModelSurface,
} from '~/server/prom/app-listings-read-model.metrics';
import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import type {
  ListAppListingsInput,
  ListingCard,
  StoreGridItem,
} from '~/server/schema/blocks/app-listing-read.schema';
import {
  APP_INDEX_VIEWER_HEADER,
  APP_INDEX_VIEWER_TTL_SECONDS,
  appIndexViewerFor,
  appIndexViewerKeyUsable,
  signAppIndexViewer,
} from '~/server/services/blocks/app-index-viewer-token';
import { IndexBreaker } from '~/server/services/blocks/app-index-search.service';
import type { ListAvailableListingsOpts } from '~/server/services/blocks/app-listing.service';
import { outboundFetch } from '~/server/utils/fetch-timeout';
import { createCachedFlagGate, readFliptSwitch } from '~/server/utils/otel-withspan-gate';
import { isAppSubListingId, isSubListingCard } from '~/shared/constants/app-sub-listing.constants';

/** At most this many mismatch log lines per minute per process; the counters count every one. */
export const LOG_LINES_PER_MINUTE = 30;

// ---------------------------------------------------------------------------
// The read model's answer
// ---------------------------------------------------------------------------

// `internal/listingread` Card: the site's ListingCard less `id` and `kindData.appBlockId`.
const readModelCardSchema = z.object({
  slug: z.string().min(1),
  kind: z.string(),
  name: z.string(),
  tagline: z.string().nullable(),
  category: z.string().nullable(),
  contentRating: z.string().nullable(),
  iconUrl: z.string().nullable(),
  coverUrl: z.string().nullable(),
  creator: z
    .object({ id: z.number(), username: z.string().nullable(), image: z.string().nullable() })
    .nullable(),
  recommend: z.object({
    recommendedCount: z.number(),
    notRecommendedCount: z.number(),
    recommendPct: z.number().nullable(),
  }),
  reviewCount: z.number(),
  isBeta: z.boolean(),
  isOfficial: z.boolean(),
  openCount: z.number().nullable(),
  updatedAt: z.string().optional(),
  kindData: z.object({
    kind: z.string(),
    hasPage: z.boolean().optional(),
    liveUrl: z.string().nullable().optional(),
    externalUrl: z.string().nullable().optional(),
  }),
});
export type ReadModelCard = z.infer<typeof readModelCardSchema>;
const readModelPageSchema = z.object({
  items: z.array(readModelCardSchema),
  nextCursor: z.string().optional(),
});
type ReadModelPage = z.infer<typeof readModelPageSchema>;

// ---------------------------------------------------------------------------
// Pure parts: the cursor, the query, the comparison
// ---------------------------------------------------------------------------

/**
 * The read model's keyset cursor positioned where a database cursor is: after the row with sort
 * key `sortKey` and slug `slug` (the read model's tie-break), with the top-rated mean pinned when
 * the database cursor pins one, so both sides rank page 2 onward with the same mean. The format is
 * `listingread.EncodeCursor`: base64url, unpadded, of "rm1␟key␟slug[␟mean]".
 */
export function readModelCursor(sortKey: string, slug: string, mean: number | null): string {
  const fields = ['rm1', sortKey, slug];
  if (mean != null) fields.push(String(mean));
  return Buffer.from(fields.join('\x1f'), 'utf8').toString('base64url');
}

/** `GET /listings` parameters for the database query `input` (no text query: never sent). */
export function readModelListParams(
  input: Pick<ListAppListingsInput, 'kind' | 'category' | 'sort' | 'limit' | 'userId'>,
  cursor: string | undefined
): URLSearchParams {
  const params = new URLSearchParams({ sort: input.sort, limit: String(input.limit) });
  if (input.kind !== 'all') params.set('kind', input.kind);
  if (input.category) params.set('category', input.category);
  if (input.userId != null) params.set('userId', String(input.userId));
  if (cursor) params.set('cursor', cursor);
  return params;
}

const sameNullable = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? null) === (b ?? null);

function sameTime(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) ? ta === tb : a === b;
}

/** Which compared fields of one listing differ between its database card and its read-model card. */
export function cardFieldDiffs(db: ListingCard, rm: ReadModelCard): ReadModelComparedField[] {
  const out: ReadModelComparedField[] = [];
  const check = (field: ReadModelComparedField, same: boolean) => {
    if (!same) out.push(field);
  };
  check('name', db.name === rm.name);
  check('tagline', sameNullable(db.tagline, rm.tagline));
  check('category', sameNullable(db.category, rm.category));
  check('contentRating', sameNullable(db.contentRating, rm.contentRating));
  check('iconUrl', sameNullable(db.iconUrl, rm.iconUrl));
  check('coverUrl', sameNullable(db.coverUrl, rm.coverUrl));
  check(
    'creator',
    db.creator === null || rm.creator === null
      ? db.creator === rm.creator
      : db.creator.id === rm.creator.id &&
          sameNullable(db.creator.username, rm.creator.username) &&
          sameNullable(db.creator.image, rm.creator.image)
  );
  check('recommendedCount', db.recommend.recommendedCount === rm.recommend.recommendedCount);
  check(
    'notRecommendedCount',
    db.recommend.notRecommendedCount === rm.recommend.notRecommendedCount
  );
  const pa = db.recommend.recommendPct;
  const pb = rm.recommend.recommendPct;
  check('recommendPct', pa === null || pb === null ? pa === pb : Math.abs(pa - pb) < 1e-9);
  check('reviewCount', db.reviewCount === rm.reviewCount);
  check('isBeta', db.isBeta === rm.isBeta);
  check('isOfficial', (db.isOfficial ?? false) === rm.isOfficial);
  check('openCount', (db.openCount ?? null) === rm.openCount);
  check('updatedAt', sameTime(db.updatedAt, rm.updatedAt));
  const kd = db.kindData;
  const rk = rm.kindData;
  check(
    'kindData',
    kd.kind === rk.kind &&
      (kd.kind === 'onsite'
        ? kd.hasPage === rk.hasPage && sameNullable(kd.liveUrl, rk.liveUrl)
        : sameNullable(kd.externalUrl, rk.externalUrl))
  );
  return out;
}

/** The two pages laid side by side, before any slug on one page only is checked. */
export type PageDiff = {
  onlyDb: string[];
  onlyReadModel: string[];
  /** For each slug on both pages, the fields that differ (only slugs with a difference). */
  fields: Map<string, ReadModelComparedField[]>;
  slugs: number;
};

export function diffPages(db: readonly ListingCard[], rm: readonly ReadModelCard[]): PageDiff {
  const rmBySlug = new Map(rm.map((c) => [c.slug, c] as const));
  const dbSlugs = new Set(db.map((c) => c.slug));
  const fields = new Map<string, ReadModelComparedField[]>();
  const onlyDb: string[] = [];
  for (const card of db) {
    const other = rmBySlug.get(card.slug);
    if (!other) {
      onlyDb.push(card.slug);
      continue;
    }
    const diffs = cardFieldDiffs(card, other);
    if (diffs.length) fields.set(card.slug, diffs);
  }
  const onlyReadModel = rm.filter((c) => !dbSlugs.has(c.slug)).map((c) => c.slug);
  return { onlyDb, onlyReadModel, fields, slugs: dbSlugs.size + onlyReadModel.length };
}

/**
 * The comparison of one page, once every slug on one page only has been checked against the other
 * side: `missing` are database-page slugs the read model does not show this viewer at all, `extra`
 * read-model-page slugs the database does not show this viewer at all.
 */
export function comparePages(
  db: { items: readonly ListingCard[]; nextCursor?: string },
  rm: ReadModelPage,
  diff: PageDiff,
  missing: ReadonlySet<string>,
  extra: ReadonlySet<string>
): ReadModelComparison {
  const kinds: Record<ReadModelMismatchKind, number> = {
    visibility_missing: missing.size,
    visibility_extra: extra.size,
    media: 0,
    field: 0,
  };
  const fields: Partial<Record<ReadModelComparedField, number>> = {};
  for (const diffs of diff.fields.values()) {
    if (diffs.some((f) => READ_MODEL_MEDIA_FIELDS.includes(f))) kinds.media++;
    if (diffs.some((f) => !READ_MODEL_MEDIA_FIELDS.includes(f))) kinds.field++;
    for (const f of diffs) fields[f] = (fields[f] ?? 0) + 1;
  }
  const dbOrder = db.items.map((c) => c.slug).filter((s) => !missing.has(s));
  const rmOrder = rm.items.map((c) => c.slug).filter((s) => !extra.has(s));
  const order =
    dbOrder.length !== rmOrder.length ||
    dbOrder.some((s, i) => s !== rmOrder[i]) ||
    !!db.nextCursor !== !!rm.nextCursor;
  return { slugs: diff.slugs, kinds, fields, order };
}

// ---------------------------------------------------------------------------
// The shadow
// ---------------------------------------------------------------------------

export type ReadModelShadowConfig = {
  url: string | undefined;
  key: string | undefined;
  sample: number;
  maxInFlight: number;
  timeoutMs: number;
};

/** A database cursor, decoded (`decodeListingCursor`). */
export type DecodedDbCursor = {
  cursorSortKey: string | null;
  cursorId: string | null;
  cursorMean: number | null;
};

export type ShadowLogEntry = {
  surface: ReadModelSurface;
  visibilityMissing: string[];
  visibilityExtra: string[];
  /** Slug → the fields that differ. */
  fields: Record<string, ReadModelComparedField[]>;
  order: boolean;
};

export type ListingsShadowDeps = {
  /** The `app-listings-read-model` flag. */
  enabled: () => boolean;
  config: () => ReadModelShadowConfig;
  random: () => number;
  nowMs: () => number;
  fetch: (
    url: string,
    init: { headers: Record<string, string>; timeoutMs: number }
  ) => Promise<Response>;
  /** `decodeListingCursor`. */
  decodeCursor: (cursor: string | undefined) => DecodedDbCursor | Promise<DecodedDbCursor>;
  /** The slug of the listing `id`, or null when it has none. */
  slugOfListing: (id: string) => Promise<string | null>;
  /** `listStoreListingsBySlugs`: what the database shows this viewer of `slugs`. */
  dbBySlugs: (
    slugs: string[],
    input: ListAppListingsInput,
    opts: ListAvailableListingsOpts
  ) => Promise<ListingCard[]>;
  breaker: IndexBreaker;
  log: (entry: ShadowLogEntry) => void;
};

class ReadModelUnavailable extends Error {
  constructor(readonly outcome: ReadModelShadowOutcome) {
    super(outcome);
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * At most `perMinute` calls of `fn` in any minute (fixed one-minute windows); the rest are dropped.
 */
export function rateLimited<T>(
  fn: (x: T) => void,
  perMinute: number,
  nowMs: () => number
): (x: T) => void {
  let windowStart = Number.NEGATIVE_INFINITY;
  let used = 0;
  return (x) => {
    const t = nowMs();
    if (t - windowStart >= 60_000) {
      windowStart = t;
      used = 0;
    }
    if (used >= perMinute) return;
    used++;
    fn(x);
  };
}

/**
 * A shadow with its own in-flight count. `shadow` decides synchronously whether to shadow this
 * page, and returns the background read's promise when it does (undefined when it does not); it
 * never throws and its promise never rejects, so a caller only `void`s it.
 */
export function createListingsReadModelShadow(deps: ListingsShadowDeps) {
  let inFlight = 0;

  async function fetchPage(
    cfg: ReadModelShadowConfig,
    params: URLSearchParams,
    token: string
  ): Promise<ReadModelPage> {
    const base = (cfg.url as string).replace(/\/+$/, '');
    let res: Response;
    try {
      res = await deps.fetch(`${base}/listings?${params}`, {
        headers: { accept: 'application/json', [APP_INDEX_VIEWER_HEADER]: token },
        timeoutMs: cfg.timeoutMs,
      });
    } catch (err) {
      throw new ReadModelUnavailable(isTimeout(err) ? 'timeout' : 'error');
    }
    if (res.status === 503) throw new ReadModelUnavailable('not_ready');
    if (!res.ok) throw new ReadModelUnavailable('error');
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new ReadModelUnavailable(isTimeout(err) ? 'timeout' : 'bad_response');
    }
    const parsed = readModelPageSchema.safeParse(body);
    if (!parsed.success) throw new ReadModelUnavailable('bad_response');
    return parsed.data;
  }

  async function run(
    surface: ReadModelSurface,
    cfg: ReadModelShadowConfig,
    token: string,
    input: ListAppListingsInput,
    opts: ListAvailableListingsOpts,
    served: { items: ListingCard[]; nextCursor?: string }
  ): Promise<ReadModelShadowOutcome> {
    // The database cursor, moved to the same position in the read model's terms.
    let cursor: string | undefined;
    if (input.cursor) {
      const decoded = await deps.decodeCursor(input.cursor);
      if (decoded.cursorId !== null && decoded.cursorSortKey !== null) {
        // A sub-listing id is a position the read model has no row for.
        if (isAppSubListingId(decoded.cursorId)) return 'unsupported_input';
        let slug: string | null;
        try {
          slug = await deps.slugOfListing(decoded.cursorId);
        } catch {
          return 'db_error';
        }
        // The listing the cursor sits after is gone: its slug cannot be named.
        if (!slug) return 'unsupported_input';
        cursor = readModelCursor(decoded.cursorSortKey, slug, decoded.cursorMean);
      }
    }

    let rm: ReadModelPage;
    try {
      rm = await fetchPage(cfg, readModelListParams(input, cursor), token);
    } catch (err) {
      const outcome = err instanceof ReadModelUnavailable ? err.outcome : 'error';
      deps.breaker.failure(outcome);
      return outcome;
    }

    const diff = diffPages(served.items, rm.items);

    // Each slug on one page only, asked of the other side by slug, with the same filters.
    const missing = new Set<string>();
    const extra = new Set<string>();
    if (diff.onlyDb.length) {
      const params = readModelListParams(input, undefined);
      params.delete('userId');
      params.delete('sort');
      params.delete('limit');
      params.set('slugs', diff.onlyDb.join(','));
      let found: ReadModelPage;
      try {
        found = await fetchPage(cfg, params, token);
      } catch (err) {
        const outcome = err instanceof ReadModelUnavailable ? err.outcome : 'error';
        deps.breaker.failure(outcome);
        return outcome;
      }
      const admitted = new Set(found.items.map((c) => c.slug));
      for (const s of diff.onlyDb) if (!admitted.has(s)) missing.add(s);
    }
    deps.breaker.success();
    if (diff.onlyReadModel.length) {
      let cards: ListingCard[];
      try {
        cards = await deps.dbBySlugs(diff.onlyReadModel, input, opts);
      } catch {
        return 'db_error';
      }
      // The slug path takes no developer filter: with one, the listing must also be that
      // developer's for the database grid to show it.
      const admitted = new Set(
        cards
          .filter((c) => input.userId == null || c.creator?.id === input.userId)
          .map((c) => c.slug)
      );
      for (const s of diff.onlyReadModel) if (!admitted.has(s)) extra.add(s);
    }

    const comparison = comparePages(served, rm, diff, missing, extra);
    recordReadModelComparison(surface, comparison);
    if (missing.size || extra.size || diff.fields.size || comparison.order) {
      deps.log({
        surface,
        visibilityMissing: [...missing],
        visibilityExtra: [...extra],
        fields: Object.fromEntries(diff.fields),
        order: comparison.order,
      });
    }
    return 'compared';
  }

  function decide(
    surface: ReadModelSurface,
    input: ListAppListingsInput,
    opts: ListAvailableListingsOpts,
    served: { items: readonly StoreGridItem[]; nextCursor?: string; search?: 'index' }
  ): Promise<void> | undefined {
    if (!deps.enabled()) return undefined;
    const cfg = deps.config();
    if (!(deps.random() < cfg.sample)) return undefined;
    const record = (outcome: ReadModelShadowOutcome) => {
      recordReadModelShadow(surface, outcome);
      return undefined;
    };
    if (!cfg.url || !appIndexViewerKeyUsable(cfg.key)) return record('unconfigured');
    const viewer = appIndexViewerFor(opts);
    if (!viewer) return record('unsupported_viewer');
    // The read model holds no sub-listing card, and a page the app index's search answered is a
    // search result, not a grid page.
    if (
      opts.includeSubListings === true ||
      served.search === 'index' ||
      served.items.some((item) => isSubListingCard(item))
    ) {
      return record('unsupported_input');
    }
    if (inFlight >= cfg.maxInFlight) return record('saturated');
    if (!deps.breaker.allow()) return record('breaker_open');
    const token = signAppIndexViewer(
      cfg.key,
      viewer,
      Math.floor(deps.nowMs() / 1000) + APP_INDEX_VIEWER_TTL_SECONDS
    );
    inFlight++;
    const page = { items: served.items as ListingCard[], nextCursor: served.nextCursor };
    return run(surface, cfg, token, input, opts, page)
      .catch((): ReadModelShadowOutcome => 'error')
      .then((outcome) => {
        recordReadModelShadow(surface, outcome);
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight--;
      });
  }

  return {
    shadow(
      surface: ReadModelSurface,
      input: ListAppListingsInput,
      opts: ListAvailableListingsOpts,
      served: { items: readonly StoreGridItem[]; nextCursor?: string; search?: 'index' }
    ): Promise<void> | undefined {
      try {
        return decide(surface, input, opts, served);
      } catch {
        return undefined;
      }
    },
    inFlight: () => inFlight,
  };
}

// ---------------------------------------------------------------------------
// This process's shadow
// ---------------------------------------------------------------------------

const listingService = () => import('~/server/services/blocks/app-listing.service');

function readConfig(): ReadModelShadowConfig {
  return {
    url: env.APP_INDEX_URL,
    key: env.APP_INDEX_VIEWER_KEY,
    sample: env.APP_LISTINGS_READ_MODEL_SHADOW_SAMPLE,
    maxInFlight: env.APP_LISTINGS_READ_MODEL_SHADOW_MAX_IN_FLIGHT,
    timeoutMs: env.APP_LISTINGS_READ_MODEL_SHADOW_TIMEOUT_MS,
  };
}

let processShadow: ReturnType<typeof createListingsReadModelShadow> | undefined;

function getProcessShadow() {
  processShadow ??= createListingsReadModelShadow({
    enabled: createCachedFlagGate(
      readFliptSwitch(() => FLIPT_FEATURE_FLAGS.APP_LISTINGS_READ_MODEL)
    ),
    config: readConfig,
    random: Math.random,
    nowMs: Date.now,
    fetch: (url, init) => outboundFetch(url, init),
    decodeCursor: async (cursor) => (await listingService()).decodeListingCursor(cursor),
    slugOfListing: async (id) => {
      const { dbRead } = await import('~/server/db/client');
      const row = await dbRead.appListing.findUnique({ where: { id }, select: { slug: true } });
      return row?.slug ?? null;
    },
    dbBySlugs: async (slugs, input, opts) =>
      (await listingService()).listStoreListingsBySlugs(slugs, input, opts),
    breaker: new IndexBreaker(undefined, undefined, (from, to, why) => {
      recordReadModelBreakerTransition(to);
      void logToAxiom({ name: 'app-listings-read-model-breaker', type: 'info', from, to, why });
    }),
    // Slugs, kinds and field names only: listing slugs are public, and nothing here names the
    // viewer or carries a card's values.
    log: rateLimited(
      (entry: ShadowLogEntry) => {
        void logToAxiom({ name: 'app-listings-read-model-mismatch', type: 'info', ...entry });
      },
      LOG_LINES_PER_MINUTE,
      Date.now
    ),
  });
  return processShadow;
}

/**
 * Shadow one served page (see the module doc). `opts` must be the options object the database read
 * was given, and `served` its answer. Returns at once; never throws.
 */
export function shadowListingPage(
  surface: ReadModelSurface,
  input: ListAppListingsInput,
  opts: ListAvailableListingsOpts,
  served: { items: readonly StoreGridItem[]; nextCursor?: string; search?: 'index' }
): void {
  try {
    void getProcessShadow().shadow(surface, input, opts, served);
  } catch {
    // A shadow never affects the request.
  }
}
