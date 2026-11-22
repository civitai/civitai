/**
 * The store grid's and the public REST list's reads of the app store's listings read model
 * (`apps/app-index-go`, `GET /listings`), behind the `app-listings-read-model` Flipt flag, whose
 * answer is one of three modes (`readReadModelMode`):
 *
 *   - `database` (the flag absent, off, or any answer not named below): every page is read from
 *     the database, and nothing is asked of the read model;
 *   - `shadow`: every page is read from the database, and for a sampled fraction the same query is
 *     asked of the read model off the response path and the two pages are compared;
 *   - `serve`: a page the read model can answer for this viewer is read from it
 *     (`serveListingPage`), and from the database when it cannot, fails, times out or the breaker
 *     is open. A sampled fraction of served pages is compared with the database page, off the
 *     response path.
 *
 * What is compared, how it is bounded and what is logged: `apps/app-index-go/LISTINGS-READ-MODEL.md`,
 * "Shadow diff" and "Serving".
 */
import * as z from 'zod';
import { env } from '~/env/server';
import {
  READ_MODEL_FIELD_CLASS,
  recordReadModelBreakerTransition,
  recordReadModelComparison,
  recordReadModelServe,
  recordReadModelShadow,
  type ReadModelComparedField,
  type ReadModelComparison,
  type ReadModelMismatchKind,
  type ReadModelServeOutcome,
  type ReadModelShadowOutcome,
  type ReadModelSurface,
} from '~/server/prom/app-listings-read-model.metrics';
import {
  FLIPT_FEATURE_FLAGS,
  ensureFliptInitialized,
  getFliptClientSync,
  getFliptLocalOverride,
  getFliptVariantDetailSync,
  isFliptSync,
} from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import type {
  ListAppListingsInput,
  ListingCard,
  ListingCardKindData,
  StoreGridItem,
} from '~/server/schema/blocks/app-listing-read.schema';
import {
  APP_INDEX_VIEWER_HEADER,
  APP_INDEX_VIEWER_TTL_SECONDS,
  appIndexViewerFor,
  appIndexViewerKeyUsable,
  signAppIndexViewer,
} from '~/server/services/blocks/app-index-viewer-token';
import {
  AppIndexUnavailable,
  IndexBreaker,
  fetchAppIndexJson,
} from '~/server/services/blocks/app-index-search.service';
import type { ListAvailableListingsOpts } from '~/server/services/blocks/app-listing.service';
import { outboundFetch } from '~/server/utils/fetch-timeout';
import { rateLimited } from '~/server/utils/shadow-sampler';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import { CACHED_FLAG_GATE_REFRESH_MS } from '~/server/utils/cached-flag-gate';
import { isAppSubListingId, isSubListingCard } from '~/shared/constants/app-sub-listing.constants';

/** What the `app-listings-read-model` flag says to do with a store grid or REST list page. */
export type ReadModelMode = 'database' | 'shadow' | 'serve';

/** The mode a variant key names: `shadow` or `serve`; any other key, or none, is `database`. */
export function readModelModeOfVariant(variantKey: string | null | undefined): ReadModelMode {
  if (variantKey === 'serve') return 'serve';
  if (variantKey === 'shadow') return 'shadow';
  return 'database';
}

/** The Flipt reads `readReadModelMode` makes, passed in so the rule is testable alone. */
export type ReadModelFlagReads = {
  /** A `FLIPT_LOCAL_OVERRIDES` value for the flag (never set in production). */
  override: () => string | undefined;
  /** The flag as a boolean flag; null when it is not one, absent, or Flipt is not ready. */
  boolean: () => boolean | null;
  /** Whether the Flipt client can evaluate (starting it when it cannot). */
  ready: () => boolean;
  /** The flag as a variant flag; null when it is not one or absent. */
  variant: () => { match: boolean; variantKey: string | null } | null;
};

/**
 * The flag's mode. A variant flag names it: `shadow` or `serve`, and anything else (no rule
 * matched, the flag disabled, an unknown variant) is `database`. A boolean flag, the shape slice 4
 * shipped with, can only shadow: on is `shadow`, off is `database`. Absent, or Flipt not ready, is
 * `database`. A boolean evaluation of a variant flag (and the reverse) fails in the Flipt engine, so
 * at most one of the two reads answers; the boolean one is asked first because it is the flag's
 * shape today, and a variant read of a boolean flag logs an evaluation error.
 */
export function readReadModelMode(reads: ReadModelFlagReads): ReadModelMode {
  const override = reads.override();
  if (override !== undefined) {
    return override === 'on' ? 'shadow' : readModelModeOfVariant(override);
  }
  const on = reads.boolean();
  if (on !== null) return on ? 'shadow' : 'database';
  if (!reads.ready()) return 'database';
  const detail = reads.variant();
  return detail?.match ? readModelModeOfVariant(detail.variantKey) : 'database';
}

/**
 * `read`, run at most once per `refreshMs`, as `createCachedFlagGate` does for a boolean flag: a
 * flip takes effect within the window, and a throw reads as `database`.
 */
export function createCachedModeGate(
  read: () => ReadModelMode,
  refreshMs: number = CACHED_FLAG_GATE_REFRESH_MS,
  now: () => number = Date.now
): () => ReadModelMode {
  let value: ReadModelMode = 'database';
  let expiresAt = Number.NEGATIVE_INFINITY;
  return () => {
    const t = now();
    if (t >= expiresAt) {
      try {
        value = read();
      } catch {
        value = 'database';
      }
      expiresAt = t + refreshMs;
    }
    return value;
  };
}

/** At most this many mismatch log lines per minute per process; the counters count every one. */
export const LOG_LINES_PER_MINUTE = 30;

// `internal/listingread` Card. `id`, and an on-site card's `kindData.appBlockId`, are required: a
// card without them is not one this shadow can compare (`bad_response`).
const readModelCardSchema = z.object({
  id: z.string().min(1),
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
  kindData: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('onsite'),
      appBlockId: z.string().nullable(),
      hasPage: z.boolean().optional(),
      liveUrl: z.string().nullable().optional(),
    }),
    z.object({ kind: z.literal('offsite'), externalUrl: z.string().nullable().optional() }),
  ]),
});
export type ReadModelCard = z.infer<typeof readModelCardSchema>;
const readModelPageSchema = z.object({
  items: z.array(readModelCardSchema),
  nextCursor: z.string().optional(),
});
type ReadModelPage = z.infer<typeof readModelPageSchema>;

/**
 * The read model's keyset cursor at a database cursor's position: after the row with sort key
 * `sortKey` and listing id `id` (both sides' tie-break), with the top-rated mean pinned when the
 * database cursor pins one, so both rank page 2 onward with the same mean. The format is
 * `listingread.EncodeCursor`: base64url, unpadded, of "rm2␟key␟id[␟mean]".
 */
export function readModelCursor(sortKey: string, id: string, mean: number | null): string {
  const fields = ['rm2', sortKey, id];
  if (mean != null) fields.push(String(mean));
  return Buffer.from(fields.join('\x1f'), 'utf8').toString('base64url');
}

/**
 * A read-model cursor's position: the inverse of {@link readModelCursor}. A served page's next
 * cursor is handed to the client re-encoded in the database's format (`encodeListingCursor`), so
 * the next page can be read from either side (the flag flipped, or the read model failed in between)
 * from the same position with the same pinned mean. Null when `cursor` is not a read-model cursor
 * of this version, or pins a mean outside [0, 1].
 */
export function decodeReadModelCursor(
  cursor: string
): { sortKey: string; id: string; mean?: number } | null {
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('\x1f');
  if (parts.length < 3 || parts.length > 4 || parts[0] !== 'rm2') return null;
  const [, sortKey, id, meanField] = parts;
  if (!id) return null;
  if (meanField === undefined) return { sortKey, id };
  const mean = meanField === '' ? NaN : Number(meanField);
  if (!Number.isFinite(mean) || mean < 0 || mean > 1) return null;
  return { sortKey, id, mean };
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

/**
 * A read-model card as the store card it stands in for, or null when it cannot be one: an on-site
 * card needs `hasPage` and a `liveUrl`, and its `kind` must be its kind data's. The media are the
 * read model's own, already gated for the signed viewer by the store's rule (`listingMediaCeiling`
 * and `redHostMediaCeiling`, ported as `listingread.ProjectMedia`), and are served as they are.
 * `restrictedAudience` is null: the read model answers only `public`-floor viewers, whom no
 * restricted level is shown.
 */
export function servedCardOf(card: ReadModelCard): ListingCard | null {
  const kd = card.kindData;
  if (card.kind !== kd.kind) return null;
  let kindData: ListingCardKindData;
  if (kd.kind === 'onsite') {
    if (typeof kd.hasPage !== 'boolean' || typeof kd.liveUrl !== 'string') return null;
    kindData = {
      kind: 'onsite',
      appBlockId: kd.appBlockId,
      hasPage: kd.hasPage,
      liveUrl: kd.liveUrl,
    };
  } else {
    kindData = { kind: 'offsite', externalUrl: kd.externalUrl ?? null };
  }
  const creator = card.creator;
  return {
    id: card.id,
    slug: card.slug,
    kind: kd.kind,
    name: card.name,
    tagline: card.tagline,
    category: card.category,
    contentRating: card.contentRating,
    iconUrl: card.iconUrl,
    coverUrl: card.coverUrl,
    creator: creator ? { id: creator.id, username: creator.username, image: creator.image } : null,
    recommend: {
      recommendedCount: card.recommend.recommendedCount,
      notRecommendedCount: card.recommend.notRecommendedCount,
      recommendPct: card.recommend.recommendPct,
    },
    reviewCount: card.reviewCount,
    isBeta: card.isBeta,
    isOfficial: card.isOfficial,
    openCount: card.openCount,
    ...(card.updatedAt !== undefined ? { updatedAt: card.updatedAt } : {}),
    restrictedAudience: null,
    kindData,
  };
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
    kd.kind === 'onsite'
      ? rk.kind === 'onsite' &&
          kd.hasPage === rk.hasPage &&
          sameNullable(kd.liveUrl, rk.liveUrl) &&
          sameNullable(kd.appBlockId, rk.appBlockId)
      : rk.kind === 'offsite' && sameNullable(kd.externalUrl, rk.externalUrl)
  );
  return out;
}

/**
 * The two pages laid side by side, before any listing on one page only is checked. A listing is
 * matched by its id; the lists name each listing by its slug, which the by-slug check and the log
 * use. A database card and a read-model card left unmatched that share a slug are one slug naming
 * two ids: an `id` field mismatch of that slug (an identity field), never a visibility or order one.
 */
export type PageDiff = {
  onlyDb: string[];
  onlyReadModel: string[];
  /** For each listing on both pages, by slug, the fields that differ (only those with one). */
  fields: Map<string, ReadModelComparedField[]>;
  /** Slugs that name a different listing id on each side. */
  idMismatch: Set<string>;
  slugs: number;
};

export function diffPages(db: readonly ListingCard[], rm: readonly ReadModelCard[]): PageDiff {
  const rmById = new Map(rm.map((c) => [c.id, c] as const));
  const dbIds = new Set(db.map((c) => c.id));
  const fields = new Map<string, ReadModelComparedField[]>();
  const unmatchedDb: ListingCard[] = [];
  for (const card of db) {
    const other = rmById.get(card.id);
    if (!other) {
      unmatchedDb.push(card);
      continue;
    }
    const diffs = cardFieldDiffs(card, other);
    if (diffs.length) fields.set(card.slug, diffs);
  }
  const unmatchedRm = rm.filter((c) => !dbIds.has(c.id));
  const rmSlugs = new Set(unmatchedRm.map((c) => c.slug));
  const idMismatch = new Set(unmatchedDb.filter((c) => rmSlugs.has(c.slug)).map((c) => c.slug));
  for (const slug of idMismatch) fields.set(slug, ['id']);
  const onlyDb = unmatchedDb.map((c) => c.slug).filter((s) => !idMismatch.has(s));
  const onlyReadModel = unmatchedRm.map((c) => c.slug).filter((s) => !idMismatch.has(s));
  return { onlyDb, onlyReadModel, fields, idMismatch, slugs: db.length + onlyReadModel.length };
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
    identity_field: 0,
    stats_field: 0,
  };
  const fields: Partial<Record<ReadModelComparedField, number>> = {};
  for (const diffs of diff.fields.values()) {
    const classes = new Set(diffs.map((f) => READ_MODEL_FIELD_CLASS[f]));
    if (classes.has('media')) kinds.media++;
    if (classes.has('identity')) kinds.identity_field++;
    if (classes.has('stats')) kinds.stats_field++;
    for (const f of diffs) fields[f] = (fields[f] ?? 0) + 1;
  }
  // By id, as the pages were matched; a slug naming two ids is already an identity mismatch.
  const kept = (slug: string) => !diff.idMismatch.has(slug);
  const dbOrder = db.items.filter((c) => !missing.has(c.slug) && kept(c.slug)).map((c) => c.id);
  const rmOrder = rm.items.filter((c) => !extra.has(c.slug) && kept(c.slug)).map((c) => c.id);
  const order =
    dbOrder.length !== rmOrder.length ||
    dbOrder.some((s, i) => s !== rmOrder[i]) ||
    !!db.nextCursor !== !!rm.nextCursor;
  return { slugs: diff.slugs, kinds, fields, order };
}

export type ReadModelShadowConfig = {
  url: string | undefined;
  key: string | undefined;
  sample: number;
  maxInFlight: number;
  timeoutMs: number;
  /** How long a served page waits for the read model before reading the database instead. */
  serveTimeoutMs: number;
};

/** A page as the database read answers it, and as a served page stands in for it. */
export type ListingPage = { items: readonly StoreGridItem[]; nextCursor?: string };

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
  /** The `app-listings-read-model` flag's mode for a surface. */
  mode: (surface: ReadModelSurface) => ReadModelMode;
  config: () => ReadModelShadowConfig;
  random: () => number;
  nowMs: () => number;
  fetch: (
    url: string,
    init: { headers: Record<string, string>; timeoutMs: number }
  ) => Promise<Response>;
  /** `decodeListingCursor`. */
  decodeCursor: (cursor: string | undefined) => DecodedDbCursor | Promise<DecodedDbCursor>;
  /** `encodeListingCursor`. */
  encodeCursor: (sortKey: string, id: string, mean?: number) => string | Promise<string>;
  /** `listAvailableListings`: the database page a served page is compared with. */
  dbPage: (input: ListAppListingsInput, opts: ListAvailableListingsOpts) => Promise<ListingPage>;
  /** `listStoreListingsBySlugs`: what the database shows this viewer of `slugs`. */
  dbBySlugs: (
    slugs: string[],
    input: ListAppListingsInput,
    opts: ListAvailableListingsOpts
  ) => Promise<ListingCard[]>;
  breaker: IndexBreaker;
  log: (entry: ShadowLogEntry) => void;
};

/**
 * What a database read of the shadow's own resolves to when it outlives the shadow timeout
 * (`withTimeoutFallback`). The shadow stops waiting and frees its in-flight slot; the query itself
 * is not cancelled, and finishes or fails on the database's own terms.
 */
const TIMED_OUT = Symbol('timed out');

/**
 * The served page, or why the database is read instead. `served` keeps the read model's own page
 * for the comparison beside it.
 */
type ServeAttempt =
  | { served: { items: ListingCard[]; nextCursor?: string }; rm: ReadModelPage; token: string }
  | { fallback: ReadModelServeOutcome };

/**
 * Serving and shadowing with one in-flight count and one breaker.
 *
 * `shadow` (mode `shadow`) decides synchronously whether to compare a page the database served,
 * and returns the background read's promise when it does (undefined when it does not), which
 * settles once the page's outcome is recorded; the page keeps its in-flight slot until every
 * database read it started has settled, which can be later. It never throws and its promise never
 * rejects, so a caller only `void`s it.
 *
 * `serve` (mode `serve`) answers a page from the read model when it can, and from `dbRead`
 * otherwise; `dbRead` is called at most once, and its own failure is the request's, exactly as with
 * the flag off. Outside mode `serve` it is `dbRead` and nothing else. A served page is compared with
 * the database page like a shadowed one (same sample, in-flight cap and breaker), off the response
 * path: `servedComparison` returns that background read's promise, for tests.
 */
export function createListingsReadModelShadow(deps: ListingsShadowDeps) {
  let inFlight = 0;
  let servedComparison: Promise<void> | undefined;

  function fetchPage(
    cfg: ReadModelShadowConfig,
    params: URLSearchParams,
    token: string,
    timeoutMs: number = cfg.timeoutMs
  ): Promise<ReadModelPage> {
    const base = (cfg.url as string).replace(/\/+$/, '');
    return fetchAppIndexJson(
      deps.fetch,
      `${base}/listings?${params}`,
      {
        headers: { accept: 'application/json', [APP_INDEX_VIEWER_HEADER]: token },
        timeoutMs,
      },
      readModelPageSchema
    );
  }
  const failureOf = (err: unknown): ReadModelShadowOutcome & ReadModelServeOutcome =>
    err instanceof AppIndexUnavailable ? err.reason : 'error';

  const mode = (surface: ReadModelSurface): ReadModelMode => {
    try {
      return deps.mode(surface);
    } catch {
      return 'database';
    }
  };

  /**
   * The read model's cursor at the database cursor `cursor`'s position: undefined for the first
   * page (no cursor, or one the database also reads as the first page), null for a position the
   * read model has no row for (after a sub-listing card).
   */
  async function readModelCursorOf(cursor: string | undefined): Promise<string | undefined | null> {
    if (!cursor) return undefined;
    const decoded = await deps.decodeCursor(cursor);
    if (decoded.cursorId === null || decoded.cursorSortKey === null) return undefined;
    if (isAppSubListingId(decoded.cursorId)) return null;
    return readModelCursor(decoded.cursorSortKey, decoded.cursorId, decoded.cursorMean);
  }

  /**
   * One page's comparison. With `sides.db` (a shadowed page) the read model is asked for the same
   * page; with `sides.rm` (a served page) the database is. Every read-model call goes through the
   * breaker: it is asked immediately before the first one, and from there every return answers it
   * exactly once (failure for a read-model failure or a database timeout, success otherwise), so a
   * half-open probe it admits is always answered and consecutive failures are never reset by the
   * same page. A page that makes no read-model call never touches it.
   */
  async function run(
    surface: ReadModelSurface,
    cfg: ReadModelShadowConfig,
    token: string,
    input: ListAppListingsInput,
    opts: ListAvailableListingsOpts,
    sides: { db: { items: ListingCard[]; nextCursor?: string } } | { rm: ReadModelPage },
    pending: Promise<unknown>[]
  ): Promise<ReadModelShadowOutcome> {
    // One of the shadow's own database reads, waited on for at most the shadow timeout. The read
    // itself is not cancelled by the timeout, so it is kept in `pending` and the page's in-flight
    // slot is held until it settles: with a slow replica, the in-flight cap still bounds how much
    // database work the shadow has outstanding.
    const dbRead = <T>(read: Promise<T>): Promise<T | typeof TIMED_OUT> => {
      pending.push(read.catch(() => undefined));
      return withTimeoutFallback<T | typeof TIMED_OUT>(read, cfg.timeoutMs, TIMED_OUT);
    };
    // Whether a read-model call was admitted that the breaker has not been answered for.
    let owed = false;
    const answer = (failure?: string) => {
      if (!owed) return;
      owed = false;
      if (failure === undefined) deps.breaker.success();
      else deps.breaker.failure(failure);
    };
    const askReadModel = async (
      params: URLSearchParams
    ): Promise<ReadModelPage | ReadModelShadowOutcome> => {
      if (!owed) {
        if (!deps.breaker.allow()) return 'breaker_open';
        owed = true;
      }
      try {
        return await fetchPage(cfg, params, token);
      } catch (err) {
        const outcome = failureOf(err);
        answer(outcome);
        return outcome;
      }
    };

    let db: { items: ListingCard[]; nextCursor?: string };
    let rm: ReadModelPage;
    if ('db' in sides) {
      db = sides.db;
      // The database cursor, at the same position in the read model's terms: both break ties by id.
      const cursor = await readModelCursorOf(input.cursor);
      // A sub-listing id is a position the read model has no row for.
      if (cursor === null) return 'unsupported_input';
      const page = await askReadModel(readModelListParams(input, cursor));
      if (typeof page === 'string') return page;
      rm = page;
    } else {
      rm = sides.rm;
      let page: ListingPage | typeof TIMED_OUT;
      try {
        page = await dbRead(deps.dbPage(input, opts));
      } catch {
        return 'db_error';
      }
      if (page === TIMED_OUT) return 'db_timeout';
      // A served page never asks for sub-listing cards, so the database page has none.
      if (page.items.some((item) => isSubListingCard(item))) return 'unsupported_input';
      db = { items: page.items as ListingCard[], nextCursor: page.nextCursor };
    }

    const diff = diffPages(db.items, rm.items);

    // Each slug on one page only, asked of the other side by slug, with the same filters.
    const missing = new Set<string>();
    const extra = new Set<string>();
    if (diff.onlyDb.length) {
      // The read model's slug path takes no developer filter (it answers 400), so with one the
      // listing must also be that developer's, checked on the card below: a listing of another
      // developer is a visibility mismatch, never a paging difference.
      const params = readModelListParams(input, undefined);
      params.delete('userId');
      params.delete('sort');
      params.delete('limit');
      params.set('slugs', diff.onlyDb.join(','));
      const found = await askReadModel(params);
      if (typeof found === 'string') return found;
      const admitted = new Set(
        found.items
          .filter((c) => input.userId == null || c.creator?.id === input.userId)
          .map((c) => c.slug)
      );
      for (const s of diff.onlyDb) if (!admitted.has(s)) missing.add(s);
    }
    if (diff.onlyReadModel.length) {
      let cards: ListingCard[] | typeof TIMED_OUT;
      try {
        cards = await dbRead(deps.dbBySlugs(diff.onlyReadModel, input, opts));
      } catch {
        // The read model answered; a database failure is not its failure.
        answer();
        return 'db_error';
      }
      if (cards === TIMED_OUT) {
        answer('db_timeout');
        return 'db_timeout';
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

    answer();
    const comparison = comparePages(db, rm, diff, missing, extra);
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

  /** Runs one comparison in the background, holding an in-flight slot until it is done. */
  function start(
    surface: ReadModelSurface,
    cfg: ReadModelShadowConfig,
    token: string,
    input: ListAppListingsInput,
    opts: ListAvailableListingsOpts,
    sides: Parameters<typeof run>[5]
  ): Promise<void> {
    inFlight++;
    const pending: Promise<unknown>[] = [];
    const done = run(surface, cfg, token, input, opts, sides, pending)
      .catch((): ReadModelShadowOutcome => 'error')
      .then((outcome) => {
        recordReadModelShadow(surface, outcome);
      })
      .catch(() => undefined);
    // The slot is freed once the page is done AND every database read it started has settled,
    // including one it stopped waiting for at the timeout.
    void done
      .then(() => Promise.allSettled(pending))
      .finally(() => {
        inFlight--;
      });
    return done;
  }

  /** The sample and the in-flight cap, shared by both comparisons; recorded when it refuses. */
  function admit(surface: ReadModelSurface, cfg: ReadModelShadowConfig): boolean | undefined {
    if (!(deps.random() < cfg.sample)) return undefined;
    if (inFlight >= cfg.maxInFlight) {
      recordReadModelShadow(surface, 'saturated');
      return false;
    }
    return true;
  }

  function decide(
    surface: ReadModelSurface,
    input: ListAppListingsInput,
    opts: ListAvailableListingsOpts,
    served: { items: readonly StoreGridItem[]; nextCursor?: string; search?: 'index' }
  ): Promise<void> | undefined {
    if (mode(surface) !== 'shadow') return undefined;
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
    // Checked without taking the half-open probe (that is taken just before the first read-model
    // call): while the breaker is open, a page does no database work either.
    if (deps.breaker.refusing()) return record('breaker_open');
    const token = signAppIndexViewer(
      cfg.key,
      viewer,
      Math.floor(deps.nowMs() / 1000) + APP_INDEX_VIEWER_TTL_SECONDS
    );
    const page = { items: served.items as ListingCard[], nextCursor: served.nextCursor };
    return start(surface, cfg, token, input, opts, { db: page });
  }

  async function attemptServe(
    input: ListAppListingsInput,
    opts: ListAvailableListingsOpts
  ): Promise<ServeAttempt> {
    const cfg = deps.config();
    if (!cfg.url || !appIndexViewerKeyUsable(cfg.key)) return { fallback: 'unconfigured' };
    // Moderator screens stay on the database, whatever floor they read the store at.
    if (opts.viewer?.isModerator === true) return { fallback: 'unsupported_viewer' };
    const viewer = appIndexViewerFor(opts);
    if (!viewer) return { fallback: 'unsupported_viewer' };
    if (opts.includeSubListings === true) return { fallback: 'unsupported_input' };
    const cursor = await readModelCursorOf(input.cursor);
    if (cursor === null) return { fallback: 'unsupported_input' };
    const token = signAppIndexViewer(
      cfg.key,
      viewer,
      Math.floor(deps.nowMs() / 1000) + APP_INDEX_VIEWER_TTL_SECONDS
    );
    // From here every return answers the breaker exactly once.
    if (!deps.breaker.allow()) return { fallback: 'breaker_open' };
    let rm: ReadModelPage;
    try {
      rm = await fetchPage(cfg, readModelListParams(input, cursor), token, cfg.serveTimeoutMs);
    } catch (err) {
      const outcome = failureOf(err);
      deps.breaker.failure(outcome);
      return { fallback: outcome };
    }
    const items: ListingCard[] = [];
    for (const card of rm.items) {
      const servedCard = servedCardOf(card);
      if (!servedCard) {
        deps.breaker.failure('bad_response');
        return { fallback: 'bad_response' };
      }
      items.push(servedCard);
    }
    let nextCursor: string | undefined;
    if (rm.nextCursor) {
      const position = decodeReadModelCursor(rm.nextCursor);
      if (position === null) {
        deps.breaker.failure('bad_response');
        return { fallback: 'bad_response' };
      }
      try {
        nextCursor = await deps.encodeCursor(position.sortKey, position.id, position.mean);
      } catch {
        // Not the read model's failure: it answered a servable page.
        deps.breaker.success();
        return { fallback: 'error' };
      }
    }
    deps.breaker.success();
    return { served: nextCursor ? { items, nextCursor } : { items }, rm, token };
  }

  async function serve<P extends ListingPage>(
    surface: ReadModelSurface,
    input: ListAppListingsInput,
    opts: ListAvailableListingsOpts,
    dbRead: () => Promise<P>
  ): Promise<P | { items: ListingCard[]; nextCursor?: string }> {
    if (mode(surface) !== 'serve') return dbRead();
    let attempt: ServeAttempt;
    try {
      attempt = await attemptServe(input, opts);
    } catch {
      attempt = { fallback: 'error' };
    }
    if ('fallback' in attempt) {
      recordReadModelServe(surface, attempt.fallback);
      return dbRead();
    }
    recordReadModelServe(surface, 'served');
    try {
      const cfg = deps.config();
      if (admit(surface, cfg)) {
        servedComparison = start(surface, cfg, attempt.token, input, opts, { rm: attempt.rm });
      }
    } catch {
      // The comparison never affects the response.
    }
    return attempt.served;
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
    serve,
    servedComparison: () => servedComparison,
    inFlight: () => inFlight,
  };
}

const listingService = () => import('~/server/services/blocks/app-listing.service');

function readConfig(): ReadModelShadowConfig {
  return {
    url: env.APP_INDEX_URL,
    key: env.APP_INDEX_VIEWER_KEY,
    sample: env.APP_LISTINGS_READ_MODEL_SHADOW_SAMPLE,
    maxInFlight: env.APP_LISTINGS_READ_MODEL_SHADOW_MAX_IN_FLIGHT,
    timeoutMs: env.APP_LISTINGS_READ_MODEL_SHADOW_TIMEOUT_MS,
    serveTimeoutMs: env.APP_LISTINGS_READ_MODEL_SERVE_TIMEOUT_MS,
  };
}

/**
 * The flag's mode for `surface`, from the live Flipt client (`readReadModelMode`). Evaluated for
 * the global entity with the surface as context (`surface`: `grid` or `rest_list`), so a rule can
 * serve one surface before the other: the go/no-go gate is per surface.
 */
function readFlagMode(surface: ReadModelSurface): ReadModelMode {
  const flag = FLIPT_FEATURE_FLAGS.APP_LISTINGS_READ_MODEL;
  const context = { surface };
  return readReadModelMode({
    override: () => getFliptLocalOverride(flag),
    boolean: () => isFliptSync(flag, 'global', context),
    ready: () => {
      if (getFliptClientSync()) return true;
      void ensureFliptInitialized().catch(() => undefined);
      return false;
    },
    variant: () => getFliptVariantDetailSync(flag, 'global', context),
  });
}

/** One cached mode gate per surface. */
function surfaceModeGates(): (surface: ReadModelSurface) => ReadModelMode {
  const gates = {
    grid: createCachedModeGate(() => readFlagMode('grid')),
    rest_list: createCachedModeGate(() => readFlagMode('rest_list')),
  } satisfies Record<ReadModelSurface, () => ReadModelMode>;
  return (surface) => gates[surface]();
}

let processShadow: ReturnType<typeof createListingsReadModelShadow> | undefined;

function getProcessShadow() {
  processShadow ??= createListingsReadModelShadow({
    mode: surfaceModeGates(),
    config: readConfig,
    random: Math.random,
    nowMs: Date.now,
    fetch: (url, init) => outboundFetch(url, init),
    decodeCursor: async (cursor) => (await listingService()).decodeListingCursor(cursor),
    encodeCursor: async (sortKey, id, mean) =>
      (await listingService()).encodeListingCursor(sortKey, id, mean),
    dbPage: async (input, opts) => (await listingService()).listAvailableListings(input, opts),
    dbBySlugs: async (slugs, input, opts) =>
      (await listingService()).listStoreListingsBySlugs(slugs, input, opts),
    breaker: new IndexBreaker(undefined, undefined, (from, to, why) => {
      recordReadModelBreakerTransition(to);
      void logToAxiom({
        name: 'app-listings-read-model-breaker',
        type: 'info',
        message: `breaker ${from}->${to}`,
        payload: { from, to, why },
      });
    }),
    // Slugs, kinds and field names only: listing slugs are public, and nothing here names the
    // viewer or carries a card's values.
    log: rateLimited(
      (entry: ShadowLogEntry) => {
        void logToAxiom({
          name: 'app-listings-read-model-mismatch',
          type: 'info',
          surface: entry.surface,
          payload: {
            visibilityMissing: entry.visibilityMissing,
            visibilityExtra: entry.visibilityExtra,
            fields: entry.fields,
            order: entry.order,
          },
        });
      },
      LOG_LINES_PER_MINUTE,
      Date.now
    ),
  });
  return processShadow;
}

/**
 * Shadow one page the database served (mode `shadow`; see the module doc). `opts` must be the
 * options object the database read was given, and `served` its answer. Returns at once; never
 * throws. In any other mode it does nothing: a served page is compared by `serveListingPage`.
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

/**
 * One store grid or public REST list page (see the module doc): from the read model when the flag
 * is at `serve` and it can answer this viewer and page, else `dbRead()` (the database read, with
 * `opts`). A served page's cards are the store's `ListingCard`, with the read model's media, gated
 * for the viewer `opts` describes, and its `nextCursor` in the database's format.
 */
export function serveListingPage<P extends ListingPage>(
  surface: ReadModelSurface,
  input: ListAppListingsInput,
  opts: ListAvailableListingsOpts,
  dbRead: () => Promise<P>
): Promise<P | { items: ListingCard[]; nextCursor?: string }> {
  let processServe: ReturnType<typeof createListingsReadModelShadow>;
  try {
    processServe = getProcessShadow();
  } catch {
    return dbRead();
  }
  return processServe.serve(surface, input, opts, dbRead);
}
