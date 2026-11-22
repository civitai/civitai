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
} from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import type {
  ListAppListingsInput,
  ListingCard,
  ListingCardKindData,
  StoreGridItem,
  SubListingCard,
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
  /** Whether the Flipt client can evaluate (starting it when it cannot). */
  ready: () => boolean;
  /** The flag as a variant flag; null when it is not one or absent. */
  variant: () => { match: boolean; variantKey: string | null } | null;
};

/**
 * The flag's mode. The flag is a variant flag whose variant names it: `shadow` or `serve`. Anything
 * else (no rule matched, the flag disabled, an unknown variant, the flag absent or not a variant
 * flag, Flipt not ready) is `database`. A local override is read as a variant key.
 */
export function readReadModelMode(reads: ReadModelFlagReads): ReadModelMode {
  const override = reads.override();
  if (override !== undefined) return readModelModeOfVariant(override);
  if (!reads.ready()) return 'database';
  const detail = reads.variant();
  return detail?.match ? readModelModeOfVariant(detail.variantKey) : 'database';
}

/** The one Flipt client method {@link quietVariantRead} calls. */
export type VariantEvaluator = {
  evaluateVariant(request: {
    flagKey: string;
    entityId: string;
    context: Record<string, string>;
  }): { match: boolean; variantKey?: string | null };
};

/**
 * The flag as a variant flag, for the global entity with `context`; null when there is no client,
 * or the evaluation fails (the flag is absent, or not a variant flag). Calls the client directly,
 * not `getFliptVariantDetailSync`, which reports every failed evaluation as an error: an absent flag
 * is the expected state before it is created, and this is read every few seconds per process, so it
 * must read as `database` quietly. The per-surface mode gate caches it, as the eval cache would.
 */
export function quietVariantRead(
  client: VariantEvaluator | null,
  flag: string,
  context: Record<string, string>
): { match: boolean; variantKey: string | null } | null {
  if (!client) return null;
  try {
    const evaluation = client.evaluateVariant({ flagKey: flag, entityId: 'global', context });
    return {
      match: evaluation.match,
      variantKey: evaluation.match ? evaluation.variantKey ?? null : null,
    };
  } catch {
    return null;
  }
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
// `internal/listingread` SubListingCard: the store's `SubListingCard`, which the read model answers
// only when asked for sub-listing cards. Its id must be a sub-listing id, so it can never be matched
// with a listing card.
const readModelSubListingCardSchema = z.object({
  cardType: z.literal('sub-listing'),
  id: z.string().refine((id) => isAppSubListingId(id)),
  name: z.string(),
  tagline: z.string().nullable(),
  kind: z.enum(['onsite', 'offsite']),
  category: z.string().nullable(),
  contentRating: z.string().nullable(),
  coverUrl: z.string().nullable(),
  creator: z.object({
    id: z.number(),
    username: z.string().nullable(),
    image: z.string().nullable(),
  }),
  parent: z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    name: z.string(),
    iconUrl: z.string().nullable(),
  }),
  runHref: z.string().min(1),
  external: z.literal(true).optional(),
});
export type ReadModelSubListingCard = z.infer<typeof readModelSubListingCardSchema>;
/** One card of a read-model page: a listing's, or a sub-listing's. */
export type ReadModelItem = ReadModelCard | ReadModelSubListingCard;
const readModelPageSchema = z.object({
  items: z.array(z.union([readModelSubListingCardSchema, readModelCardSchema])),
  nextCursor: z.string().optional(),
  // Set by a read model that answered with sub-listing cards on (`subListings=1`, `subListingIds`).
  // Asked for them, an answer without it is from a read model that ignored the parameter.
  subListings: z.boolean().optional(),
});
type ReadModelPage = z.infer<typeof readModelPageSchema>;

/** Whether a read-model card is a sub-listing's. */
export function isReadModelSubListingCard(item: ReadModelItem): item is ReadModelSubListingCard {
  return 'cardType' in item && item.cardType === 'sub-listing';
}

/**
 * How the comparison names a card in its checks and its log line: a listing by its slug, a
 * sub-listing (which has none) by its id. Both are public: an item's id is in its card's link.
 */
function nameOf(item: StoreGridItem | ReadModelItem): string {
  if ('cardType' in item && item.cardType === 'sub-listing') return item.id;
  return (item as ListingCard | ReadModelCard).slug;
}

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

/**
 * `GET /listings` parameters for the database query `input` (no text query: never sent), with
 * sub-listing cards when the database read mixes them in (`includeSubListings`).
 */
export function readModelListParams(
  input: Pick<ListAppListingsInput, 'kind' | 'category' | 'sort' | 'limit' | 'userId'>,
  cursor: string | undefined,
  subListings = false
): URLSearchParams {
  const params = new URLSearchParams({ sort: input.sort, limit: String(input.limit) });
  if (input.kind !== 'all') params.set('kind', input.kind);
  if (input.category) params.set('category', input.category);
  if (input.userId != null) params.set('userId', String(input.userId));
  if (cursor) params.set('cursor', cursor);
  if (subListings) params.set('subListings', '1');
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

/**
 * A read-model sub-listing card as the store's `SubListingCard`. Its cover and parent icon are the
 * read model's own, gated for the signed viewer by the store's rule (`subListingImageCeiling`,
 * ported as `listingread.ProjectSubListingCard`), and its link is the one the adapter built with the
 * store's own builders; all are served as they are.
 */
export function servedSubListingCardOf(card: ReadModelSubListingCard): SubListingCard {
  return {
    cardType: 'sub-listing',
    id: card.id,
    name: card.name,
    tagline: card.tagline,
    kind: card.kind,
    category: card.category,
    contentRating: card.contentRating,
    coverUrl: card.coverUrl,
    creator: { id: card.creator.id, username: card.creator.username, image: card.creator.image },
    parent: {
      id: card.parent.id,
      slug: card.parent.slug,
      name: card.parent.name,
      iconUrl: card.parent.iconUrl,
    },
    runHref: card.runHref,
    ...(card.external ? { external: true as const } : {}),
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
 * Which compared fields of one sub-listing differ between its database card and its read-model
 * card: what it is (name, tagline, kind, category, rating, author, parent, link) and its gated media
 * (its cover and its parent's icon).
 */
export function subListingFieldDiffs(
  db: SubListingCard,
  rm: ReadModelSubListingCard
): ReadModelComparedField[] {
  const out: ReadModelComparedField[] = [];
  const check = (field: ReadModelComparedField, same: boolean) => {
    if (!same) out.push(field);
  };
  check('name', db.name === rm.name);
  check('tagline', sameNullable(db.tagline, rm.tagline));
  check('kind', db.kind === rm.kind);
  check('category', sameNullable(db.category, rm.category));
  check('contentRating', sameNullable(db.contentRating, rm.contentRating));
  check('coverUrl', sameNullable(db.coverUrl, rm.coverUrl));
  check(
    'creator',
    db.creator.id === rm.creator.id &&
      sameNullable(db.creator.username, rm.creator.username) &&
      sameNullable(db.creator.image, rm.creator.image)
  );
  check(
    'parent',
    db.parent.id === rm.parent.id &&
      db.parent.slug === rm.parent.slug &&
      db.parent.name === rm.parent.name
  );
  check('parentIconUrl', sameNullable(db.parent.iconUrl, rm.parent.iconUrl));
  check('runHref', db.runHref === rm.runHref && (db.external === true) === (rm.external === true));
  return out;
}

/** The compared fields that differ between two cards of one id, of either type. */
function itemFieldDiffs(db: StoreGridItem, rm: ReadModelItem): ReadModelComparedField[] {
  const dbSub = isSubListingCard(db);
  const rmSub = isReadModelSubListingCard(rm);
  // One id naming a listing on one side and a sub-listing on the other.
  if (dbSub !== rmSub) return ['id'];
  if (dbSub && rmSub) return subListingFieldDiffs(db, rm);
  return cardFieldDiffs(db as ListingCard, rm as ReadModelCard);
}

/**
 * The two pages laid side by side, before any card on one page only is checked. A card is matched
 * by its id; the lists name each listing by its slug, which the by-slug check and the log use, and
 * each sub-listing card by its id, which the by-id check and the log use (`nameOf`). A database card
 * and a read-model card of two listings left unmatched that share a slug are one slug naming two ids:
 * an `id` field mismatch of that slug (an identity field), never a visibility or order one.
 */
export type PageDiff = {
  /** Listings on the database page only, by slug. */
  onlyDb: string[];
  /** Listings on the read-model page only, by slug. */
  onlyReadModel: string[];
  /** Sub-listing cards on the database page only, by id. */
  onlyDbSubListings: string[];
  /** Sub-listing cards on the read-model page only, by id. */
  onlyReadModelSubListings: string[];
  /** For each card on both pages, by name, the fields that differ (only those with one). */
  fields: Map<string, ReadModelComparedField[]>;
  /** Slugs that name a different listing id on each side. */
  idMismatch: Set<string>;
  /** Cards on either page: the comparison's denominator. */
  slugs: number;
};

export function diffPages(db: readonly StoreGridItem[], rm: readonly ReadModelItem[]): PageDiff {
  const rmById = new Map(rm.map((c) => [c.id, c] as const));
  const dbIds = new Set(db.map((c) => c.id));
  const fields = new Map<string, ReadModelComparedField[]>();
  const unmatchedDb: StoreGridItem[] = [];
  for (const card of db) {
    const other = rmById.get(card.id);
    if (!other) {
      unmatchedDb.push(card);
      continue;
    }
    const diffs = itemFieldDiffs(card, other);
    if (diffs.length) fields.set(nameOf(card), diffs);
  }
  const unmatchedRm = rm.filter((c) => !dbIds.has(c.id));
  const dbListings = unmatchedDb.filter((c): c is ListingCard => !isSubListingCard(c));
  const rmListings = unmatchedRm.filter((c): c is ReadModelCard => !isReadModelSubListingCard(c));
  const rmSlugs = new Set(rmListings.map((c) => c.slug));
  const idMismatch = new Set(dbListings.filter((c) => rmSlugs.has(c.slug)).map((c) => c.slug));
  for (const slug of idMismatch) fields.set(slug, ['id']);
  const onlyDb = dbListings.map((c) => c.slug).filter((s) => !idMismatch.has(s));
  const onlyReadModel = rmListings.map((c) => c.slug).filter((s) => !idMismatch.has(s));
  const onlyDbSubListings = unmatchedDb.filter((c) => isSubListingCard(c)).map((c) => c.id);
  const onlyReadModelSubListings = unmatchedRm
    .filter((c) => isReadModelSubListingCard(c))
    .map((c) => c.id);
  return {
    onlyDb,
    onlyReadModel,
    onlyDbSubListings,
    onlyReadModelSubListings,
    fields,
    idMismatch,
    slugs: db.length + onlyReadModel.length + onlyReadModelSubListings.length,
  };
}

/**
 * The comparison of one page, once every card on one page only has been checked against the other
 * side: `missing` are database-page cards (by name: a listing's slug, a sub-listing's id) the read
 * model does not show this viewer at all, `extra` read-model-page cards the database does not show
 * this viewer at all.
 */
export function comparePages(
  db: { items: readonly StoreGridItem[]; nextCursor?: string },
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
  const kept = (name: string) => !diff.idMismatch.has(name);
  const dbOrder = db.items
    .filter((c) => !missing.has(nameOf(c)) && kept(nameOf(c)))
    .map((c) => c.id);
  const rmOrder = rm.items.filter((c) => !extra.has(nameOf(c)) && kept(nameOf(c))).map((c) => c.id);
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
  /** `listStoreSubListingsByIds`: what the database grid shows this viewer of the items `ids`. */
  dbSubListingsByIds: (
    ids: string[],
    input: ListAppListingsInput,
    opts: ListAvailableListingsOpts
  ) => Promise<SubListingCard[]>;
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
  | { served: { items: StoreGridItem[]; nextCursor?: string }; rm: ReadModelPage; token: string }
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
   * page (no cursor, or one the database also reads as the first page), null for a position that
   * names no card (an empty id, which only a crafted cursor carries: refused here, so it never
   * reaches the read model or its breaker). A position after a sub-listing card is moved like any
   * other: the read model reads the item's tie-break from its id, as the database does
   * (`listingread.Rank`), with sub-listings on or off.
   */
  async function readModelCursorOf(cursor: string | undefined): Promise<string | undefined | null> {
    if (!cursor) return undefined;
    const decoded = await deps.decodeCursor(cursor);
    if (decoded.cursorId === null || decoded.cursorSortKey === null) return undefined;
    if (decoded.cursorId === '') return null;
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
    sides: { db: { items: readonly StoreGridItem[]; nextCursor?: string } } | { rm: ReadModelPage },
    pending: Promise<unknown>[]
  ): Promise<ReadModelShadowOutcome> {
    const subListings = opts.includeSubListings === true;
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
    // Asked for sub-listing cards, an answer that does not say it has them is from a read model
    // that ignored the parameter: not a page to compare.
    const unmarked = (page: ReadModelPage): boolean => {
      if (page.subListings === true) return false;
      answer('bad_response');
      return true;
    };

    let db: { items: readonly StoreGridItem[]; nextCursor?: string };
    let rm: ReadModelPage;
    if ('db' in sides) {
      db = sides.db;
      // The database cursor, at the same position in the read model's terms: both break ties by id
      // (and a sub-listing after a listing on one key, which each reads from the id).
      // Awaited only with a cursor, so a first page asks the read model in the same tick.
      const cursor = input.cursor ? await readModelCursorOf(input.cursor) : undefined;
      // A position that names no card.
      if (cursor === null) return 'unsupported_input';
      const page = await askReadModel(readModelListParams(input, cursor, subListings));
      if (typeof page === 'string') return page;
      if (subListings && unmarked(page)) return 'bad_response';
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
      db = { items: page.items, nextCursor: page.nextCursor };
    }

    const diff = diffPages(db.items, rm.items);

    // Each card on one page only, asked of the other side with the same filters: a listing by its
    // slug, a sub-listing card by its id.
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
          .filter((c): c is ReadModelCard => !isReadModelSubListingCard(c))
          .filter((c) => input.userId == null || c.creator?.id === input.userId)
          .map((c) => c.slug)
      );
      for (const s of diff.onlyDb) if (!admitted.has(s)) missing.add(s);
    }
    if (diff.onlyDbSubListings.length) {
      // The id path takes the developer filter itself: it names the parent's owner, as the grid's
      // child arm reads it, which no field of the item's card carries.
      const params = readModelListParams(input, undefined);
      params.delete('sort');
      params.delete('limit');
      params.set('subListingIds', diff.onlyDbSubListings.join(','));
      const found = await askReadModel(params);
      if (typeof found === 'string') return found;
      if (unmarked(found)) return 'bad_response';
      const admitted = new Set(
        found.items.filter((c) => isReadModelSubListingCard(c)).map((c) => c.id)
      );
      for (const id of diff.onlyDbSubListings) if (!admitted.has(id)) missing.add(id);
    }
    if (diff.onlyReadModel.length || diff.onlyReadModelSubListings.length) {
      let cards: StoreGridItem[] | typeof TIMED_OUT;
      try {
        cards = await dbRead(
          Promise.all([
            diff.onlyReadModel.length
              ? deps.dbBySlugs(diff.onlyReadModel, input, opts)
              : Promise.resolve([]),
            diff.onlyReadModelSubListings.length
              ? deps.dbSubListingsByIds(diff.onlyReadModelSubListings, input, opts)
              : Promise.resolve([]),
          ]).then(([listings, subs]): StoreGridItem[] => [...listings, ...subs])
        );
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
      // developer's for the database grid to show it. The id path applies it itself.
      const admitted = new Set(
        cards
          .filter(
            (c) =>
              isSubListingCard(c) ||
              input.userId == null ||
              (c as ListingCard).creator?.id === input.userId
          )
          .map((c) => nameOf(c))
      );
      for (const s of diff.onlyReadModel) if (!admitted.has(s)) extra.add(s);
      for (const id of diff.onlyReadModelSubListings) if (!admitted.has(id)) extra.add(id);
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
    served: { items: readonly StoreGridItem[]; nextCursor?: string; search?: 'index' },
    requestMode: ReadModelMode
  ): Promise<void> | undefined {
    if (requestMode !== 'shadow') return undefined;
    const cfg = deps.config();
    if (!(deps.random() < cfg.sample)) return undefined;
    const record = (outcome: ReadModelShadowOutcome) => {
      recordReadModelShadow(surface, outcome);
      return undefined;
    };
    if (!cfg.url || !appIndexViewerKeyUsable(cfg.key)) return record('unconfigured');
    const viewer = appIndexViewerFor(opts);
    if (!viewer) return record('unsupported_viewer');
    // A page the app index's search answered is a search result, not a grid page.
    if (served.search === 'index') return record('unsupported_input');
    if (inFlight >= cfg.maxInFlight) return record('saturated');
    // Checked without taking the half-open probe (that is taken just before the first read-model
    // call): while the breaker is open, a page does no database work either.
    if (deps.breaker.refusing()) return record('breaker_open');
    const token = signAppIndexViewer(
      cfg.key,
      viewer,
      Math.floor(deps.nowMs() / 1000) + APP_INDEX_VIEWER_TTL_SECONDS
    );
    const page = { items: served.items, nextCursor: served.nextCursor };
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
    const subListings = opts.includeSubListings === true;
    const cursor = input.cursor ? await readModelCursorOf(input.cursor) : undefined;
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
      rm = await fetchPage(
        cfg,
        readModelListParams(input, cursor, subListings),
        token,
        cfg.serveTimeoutMs
      );
    } catch (err) {
      const outcome = failureOf(err);
      deps.breaker.failure(outcome);
      return { fallback: outcome };
    }
    // Asked for sub-listing cards, an answer that does not say it has them would serve a page
    // without them; and a sub-listing card the request did not ask for is never served.
    if (subListings && rm.subListings !== true) {
      deps.breaker.failure('bad_response');
      return { fallback: 'bad_response' };
    }
    const items: StoreGridItem[] = [];
    for (const card of rm.items) {
      const servedCard = isReadModelSubListingCard(card)
        ? subListings
          ? servedSubListingCardOf(card)
          : null
        : servedCardOf(card);
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

  /**
   * A served page's cards are typed as `dbRead`'s: a sub-listing card is served only when the
   * request asked for them (`includeSubListings`), which is exactly when `dbRead`'s own page may
   * carry them (`attemptServe` refuses one otherwise).
   */
  async function serve<P extends ListingPage>(
    surface: ReadModelSurface,
    input: ListAppListingsInput,
    opts: ListAvailableListingsOpts,
    dbRead: () => Promise<P>,
    requestMode: ReadModelMode = mode(surface)
  ): Promise<P | { items: P['items']; nextCursor?: string }> {
    if (requestMode !== 'serve') return dbRead();
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
    return attempt.served as { items: P['items']; nextCursor?: string };
  }

  return {
    shadow(
      surface: ReadModelSurface,
      input: ListAppListingsInput,
      opts: ListAvailableListingsOpts,
      served: { items: readonly StoreGridItem[]; nextCursor?: string; search?: 'index' },
      requestMode?: ReadModelMode
    ): Promise<void> | undefined {
      try {
        return decide(surface, input, opts, served, requestMode ?? mode(surface));
      } catch {
        return undefined;
      }
    },
    serve,
    /** The flag's mode for `surface`: resolve it once per request and pass it to both calls. */
    mode,
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
    ready: () => {
      if (getFliptClientSync()) return true;
      void ensureFliptInitialized().catch(() => undefined);
      return false;
    },
    variant: () => quietVariantRead(getFliptClientSync(), flag, context),
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
    dbSubListingsByIds: async (ids, input, opts) =>
      (await listingService()).listStoreSubListingsByIds(ids, input, opts),
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
  served: { items: readonly StoreGridItem[]; nextCursor?: string; search?: 'index' },
  mode?: ReadModelMode
): void {
  try {
    void getProcessShadow().shadow(surface, input, opts, served, mode);
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
  dbRead: () => Promise<P>,
  mode?: ReadModelMode
): Promise<P | { items: P['items']; nextCursor?: string }> {
  let processServe: ReturnType<typeof createListingsReadModelShadow>;
  try {
    processServe = getProcessShadow();
  } catch {
    return dbRead();
  }
  return processServe.serve(surface, input, opts, dbRead, mode);
}

/**
 * The flag's mode for `surface`, for one request: resolve it once and pass it to both
 * `serveListingPage` and `shadowListingPage`, so a flip between the two calls (the mode gate's
 * cache expiring) cannot compare a page the read model served against the read model. Never throws:
 * `database` on any failure.
 */
export function listingReadModelMode(surface: ReadModelSurface): ReadModelMode {
  try {
    return getProcessShadow().mode(surface);
  } catch {
    return 'database';
  }
}
