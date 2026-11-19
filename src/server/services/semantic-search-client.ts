import { trace } from '@opentelemetry/api';
import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';

/** One creator's hits shown on a page at most, so a prolific creator cannot fill it. */
export const MAX_HITS_PER_USER = 3;

const CANDIDATE_MULTIPLIER = 3;
const MAX_HYDRATION_ROUNDS = 3;
// The search service's page maximum (a larger `limit` is an error, not a short page), and so the
// most candidates hydrated per round: each round is one id-list query on the page's fetch path.
export const MAX_CANDIDATE_LIMIT = 100;
// The search service's paging cap.
export const MAX_CANDIDATE_OFFSET = 2000;
// A filter shape Qdrant has not served recently can take 10 s on its first query (vectors, graph
// and payload indexes are on disk), then well under 1 s.
const SEARCH_SERVICE_TIMEOUT_MS = 20_000;
// Above the search service's own orchestrator wait, so a slow image embed is not paid twice.
const SIMILAR_IMAGE_TIMEOUT_MS = 35_000;

/**
 * The viewer's content gate, which every query carries. Challenges and crucibles rate the entity
 * and its cover separately, and both must pass; crucibles also flag NSFW text, and user challenges
 * are paid in the domain's currency.
 */
export type ViewerGate =
  | { kind: 'level'; nsfwLevels: number[] }
  | {
      kind: 'challenge';
      nsfwLevels: number[];
      // User challenges show only on the domain whose currency they are paid in.
      domainBuzzType: string;
      canAccessUserChallenges: boolean;
      visibleBefore: string;
    }
  | { kind: 'crucible'; nsfwLevels: number[]; allowTextNsfw: boolean };

const GATE_KIND = {
  images: 'level',
  articles: 'level',
  models: 'level',
  comics: 'level',
  models3d: 'level',
  storylines: 'level',
  collections: 'level',
  bounties: 'level',
  challenges: 'challenge',
  crucibles: 'crucible',
} as const satisfies Record<string, ViewerGate['kind']>;

export type SearchCollection = keyof typeof GATE_KIND;

export type SearchQuery = { text: string } | { similarTo: number } | { imageUrl: string };

export type QdrantCondition = Record<string, unknown>;
type PayloadValue = string | number | boolean;

/** Viewer policy and the chosen filters, decided by the caller; the search service applies them as given. */
export type CandidateFilter = {
  gate: ViewerGate;
  // Every listed tag, not any of them: each added tag narrows the results.
  tagIds?: number[];
  excludedTagIds?: number[];
  userIds?: number[];
  excludedUserIds?: number[];
  // Only these points: the viewer's own short list, so the ranking is within it.
  ids?: number[];
  excludedIds?: number[];
  // Payload key → the point matches any of the values.
  anyOf?: Record<string, PayloadValue[] | undefined>;
  // A full-text payload index on `key` holds every word of `text` (Qdrant's text match), or, with
  // `orAnyOf`, the keyword field `orAnyOf.key` holds any of its values.
  allWords?: { key: string; text: string; orAnyOf?: { key: string; values: string[] } };
  range?: { key: string; gte?: string | number; lte?: string | number };
  mustNot?: QdrantCondition[];
};

const isLevelList = (x: unknown) =>
  Array.isArray(x) && x.length > 0 && x.every((n) => Number.isInteger(n) && n > 0);

function refuse(collection: string, why: string): never {
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: `Refusing a ${collection} search without the viewer's content gate: ${why}`,
  });
}

/** The gate's own conditions. Throws rather than search unfiltered when any part is missing. */
function gateConditions(collection: SearchCollection, gate: ViewerGate | undefined) {
  if (!gate) refuse(collection, 'no gate');
  const expected = GATE_KIND[collection];
  if (!expected) refuse(collection, 'unknown collection');
  if (gate.kind !== expected) refuse(collection, `expected a ${expected} gate, got ${gate.kind}`);
  if (!isLevelList(gate.nsfwLevels)) refuse(collection, 'no browsing level');

  const levels = { any: gate.nsfwLevels };
  const must: QdrantCondition[] = [{ key: 'nsfwLevel', match: levels }];
  const must_not: QdrantCondition[] = [];
  // A 3D model is embedded from its thumbnail, rated apart from the model. A point without the
  // field matches nothing, so one written before it existed is never served.
  if (collection === 'models3d') must.push({ key: 'thumbnailNsfwLevel', match: levels });

  if (gate.kind === 'challenge') {
    if (!gate.domainBuzzType) refuse(collection, 'no domain currency');
    if (typeof gate.canAccessUserChallenges !== 'boolean')
      refuse(collection, 'no user-challenge access');
    if (!gate.visibleBefore) refuse(collection, 'no visibility cutoff');
    must.push({ key: 'coverNsfwLevel', match: levels });
    must.push({ key: 'visibleAt', range: { lte: gate.visibleBefore } });
    const isUser = { key: 'source', match: { value: 'User' } };
    must_not.push(
      gate.canAccessUserChallenges
        ? { must: [isUser], must_not: [{ key: 'buzzType', match: { value: gate.domainBuzzType } }] }
        : isUser
    );
  }

  if (gate.kind === 'crucible') {
    if (typeof gate.allowTextNsfw !== 'boolean') refuse(collection, 'no text NSFW setting');
    must.push({ key: 'coverNsfwLevel', match: levels });
    if (!gate.allowTextNsfw) must_not.push({ key: 'textNsfw', match: { value: true } });
  }

  return { must, must_not };
}

export function buildQdrantFilter(collection: SearchCollection, f: CandidateFilter) {
  const { must, must_not } = gateConditions(collection, f.gate);
  for (const tagId of f.tagIds ?? []) must.push({ key: 'tagIds', match: { value: tagId } });
  if (f.userIds?.length) must.push({ key: 'userId', match: { any: f.userIds } });
  if (f.ids?.length) must.push({ has_id: f.ids });
  if (f.allWords?.text.trim()) {
    const words = { key: f.allWords.key, match: { text: f.allWords.text } };
    const orAnyOf = f.allWords.orAnyOf;
    must.push(
      orAnyOf?.values.length
        ? { should: [words, { key: orAnyOf.key, match: { any: orAnyOf.values } }] }
        : words
    );
  }
  for (const [key, values] of Object.entries(f.anyOf ?? {}))
    if (values?.length) must.push({ key, match: { any: values } });
  if (f.range && (f.range.gte !== undefined || f.range.lte !== undefined))
    must.push({ key: f.range.key, range: { gte: f.range.gte, lte: f.range.lte } });

  if (f.excludedTagIds?.length) must_not.push({ key: 'tagIds', match: { any: f.excludedTagIds } });
  if (f.excludedUserIds?.length)
    must_not.push({ key: 'userId', match: { any: f.excludedUserIds } });
  if (f.excludedIds?.length) must_not.push({ has_id: f.excludedIds });
  must_not.push(...(f.mustNot ?? []));

  return { must, must_not };
}

const GUARD_OUTCOMES = ['pass', 'flag', 'unknown', 'unavailable', 'mismatch', 'error'] as const;
/** `none`: no guard ran on the text, a word refusal ended the search or the query was by image. */
export type GuardOutcome = (typeof GUARD_OUTCOMES)[number] | 'none';

/** The search service's query-guard verdict. Server-only: never part of a response to the browser. */
export type GuardRead = {
  outcome: GuardOutcome;
  rules: string[];
  mode: string;
  version: string | null;
};

export const GUARD_NONE: GuardRead = { outcome: 'none', rules: [], mode: '', version: null };
export const GUARD_UNKNOWN: GuardRead = { outcome: 'unknown', rules: [], mode: '', version: null };

/** A service without the full guard result (missing, or `refused` alone) reads as `unknown`. */
export function readGuard(raw: unknown): GuardRead {
  if (!raw || typeof raw !== 'object') return GUARD_UNKNOWN;
  const g = raw as Record<string, unknown>;
  if (!GUARD_OUTCOMES.includes(g.outcome as never)) return GUARD_UNKNOWN;
  return {
    outcome: g.outcome as GuardOutcome,
    rules: Array.isArray(g.rules) ? g.rules.filter((r): r is string => typeof r === 'string') : [],
    mode: typeof g.mode === 'string' ? g.mode : '',
    version: typeof g.version === 'string' ? g.version : null,
  };
}

/** Who the search is for, from the session: never from request input. */
export type SearchViewer = { isModerator: boolean };

/**
 * Ranked ids, the query as the service's spelling correction rewrote it (if it did), and the
 * guard's verdict on the text. `cacheHit` is set by the candidate cache.
 */
export type CandidateSource = (args: {
  query: SearchQuery;
  filter: CandidateFilter;
  offset: number;
  limit: number;
  viewer: SearchViewer;
  // newest: the service orders its best matches by date and pages within them. Text queries only.
  sort?: 'relevance' | 'newest';
}) => Promise<{ ids: number[]; correctedQuery?: string; guard?: GuardRead; cacheHit?: boolean }>;

export function searchServiceUrl(path: string) {
  if (!env.SEARCH_SERVICE_URL)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Semantic search is not set up' });
  return `${env.SEARCH_SERVICE_URL.replace(/\/+$/, '')}${path}`;
}

export const searchServiceAuth = (): Record<string, string> =>
  env.SEARCH_SERVICE_TOKEN ? { authorization: `Bearer ${env.SEARCH_SERVICE_TOKEN}` } : {};

async function searchServiceRequest<T>(
  path: string,
  body: unknown,
  notFound: string,
  headers: Record<string, string> = {},
  timeoutMs = SEARCH_SERVICE_TIMEOUT_MS
): Promise<T> {
  const res = await fetch(searchServiceUrl(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...searchServiceAuth(), ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err) => {
    throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Search is unavailable', cause: err });
  });
  // Only "more like this" can 404: the source is not in the index.
  if (res.status === 404) throw new TRPCError({ code: 'NOT_FOUND', message: notFound });
  if (!res.ok)
    throw new TRPCError({ code: 'BAD_GATEWAY', message: `Search service error (${res.status})` });
  return (await res.json()) as T;
}

/** The OTEL traceId, so the service's guard log line joins the semanticSearchAudit row. */
function requestIdHeader(): Record<string, string> {
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  return traceId ? { 'x-request-id': traceId } : {};
}

/**
 * The cluster search service: text through `/v1/search` (embedding and spelling correction are
 * its job), "more like this" through its read-only Qdrant pass-through. Ids only, never payload:
 * the index lags Postgres, so hydration decides what is shown. `limit` is at most
 * MAX_CANDIDATE_LIMIT; the candidate cache in front of it pages larger ranges in blocks of that size.
 */
export function searchServiceSource(
  collection: SearchCollection,
  { notFoundMessage = 'Not found' }: { notFoundMessage?: string } = {}
): CandidateSource {
  return async ({ query, filter, offset, limit, viewer, sort }) => {
    const qdrantFilter = buildQdrantFilter(collection, filter);
    const audit = await isFlipt(FLIPT_FEATURE_FLAGS.SEMANTIC_SEARCH_AUDIT);
    const headers = audit ? requestIdHeader() : {};
    if ('similarTo' in query) {
      // The source is always its own best match.
      qdrantFilter.must_not.push({ has_id: [query.similarTo] });
      const { result } = await searchServiceRequest<{
        result: { points: { id: number | string }[] };
      }>(
        `/qdrant/collections/${collection}/points/query`,
        {
          query: query.similarTo,
          filter: qdrantFilter,
          offset,
          limit,
          params: { quantization: { rescore: true, oversampling: 2 } },
          with_payload: false,
        },
        notFoundMessage,
        headers
      );
      return { ids: result.points.map((p) => Number(p.id)), guard: GUARD_NONE };
    }
    if ('imageUrl' in query) {
      // The caller has scanned and rated the image (the search upload gate) before sending it.
      const { hits } = await searchServiceRequest<{ hits: { id: number | string }[] }>(
        '/v1/similar',
        {
          collection,
          image_url: query.imageUrl,
          filter: qdrantFilter,
          offset,
          limit,
          ...(audit ? { browsing_levels: filter.gate.nsfwLevels } : {}),
        },
        notFoundMessage,
        headers,
        SIMILAR_IMAGE_TIMEOUT_MS
      );
      return { ids: hits.map((h) => Number(h.id)), guard: GUARD_NONE };
    }

    const { corrected, changes, hits, guard } = await searchServiceRequest<{
      corrected: string;
      changes: unknown[];
      hits: { id: number | string }[];
      guard?: unknown;
    }>(
      '/v1/search',
      {
        collection,
        query: query.text,
        filter: qdrantFilter,
        offset,
        limit,
        // Only when asked: a relevance search sends the request it always has.
        ...(sort === 'newest' ? { sort } : {}),
        ...(audit
          ? { browsing_levels: filter.gate.nsfwLevels, viewer_is_moderator: viewer.isModerator }
          : {}),
      },
      notFoundMessage,
      headers
    );
    return {
      ids: hits.map((h) => Number(h.id)),
      correctedQuery: changes.length ? corrected : undefined,
      guard: readGuard(guard),
    };
  };
}

// Cap on the matches ranked ahead of the rest of a text search.
const MAX_FIRST_MATCHES = 200;

/**
 * Text candidates with the points `narrow` admits first (in their own similarity order), then the
 * rest of the semantic ranking without them. The matches are fetched once per source and reused
 * for every later block, so make one per request.
 */
function withMatchesFirst(
  source: CandidateSource,
  narrow: (filter: CandidateFilter, text: string) => CandidateFilter
): CandidateSource {
  let matches: ReturnType<CandidateSource> | undefined;
  return async (args) => {
    if (!('text' in args.query) || !args.query.text.trim()) return source(args);
    matches ??= source({
      ...args,
      filter: narrow(args.filter, args.query.text),
      offset: 0,
      limit: MAX_FIRST_MATCHES,
    });
    const first = await matches;
    const rest = (offset: number, limit: number) =>
      source({
        ...args,
        filter: { ...args.filter, excludedIds: [...(args.filter.excludedIds ?? []), ...first.ids] },
        offset,
        limit,
      });
    if (args.offset >= first.ids.length) return rest(args.offset - first.ids.length, args.limit);
    const head = first.ids.slice(args.offset, args.offset + args.limit);
    const tail = head.length < args.limit ? await rest(0, args.limit - head.length) : undefined;
    return { ...first, ids: [...head, ...(tail?.ids ?? [])] };
  };
}

/**
 * The points holding every query word in `key` first. Embeddings rank meaning, so a query that is a
 * model's name, or a word of it, otherwise loses to look-alike names and spellings.
 */
/**
 * The query's possible keyword values: the whole query and each word, lowercased, as tags are
 * stored. A multi-word tag matches only as the whole query.
 */
export function queryKeywords(text: string) {
  const whole = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set([whole.join(' '), ...whole])].filter(Boolean);
}

/**
 * Points that hold every query word in `key` come first. With `orKeywordKey`, so does a point whose
 * keyword field holds the query or one of its words: the same tier, not above it.
 */
export function withWordMatchesFirst(
  source: CandidateSource,
  key: string,
  orKeywordKey?: string
): CandidateSource {
  return withMatchesFirst(source, (filter, text) => ({
    ...filter,
    allWords: {
      key,
      text,
      ...(orKeywordKey && { orAnyOf: { key: orKeywordKey, values: queryKeywords(text) } }),
    },
  }));
}

/**
 * The points carrying `tagId` first. A rare term embeds as its nearest common concept (a tiefling
 * as horns), so the images tagged with it lose to unrelated ones that share that concept.
 */
export function withTagMatchesFirst(source: CandidateSource, tagId: number): CandidateSource {
  return withMatchesFirst(source, (filter) => ({
    ...filter,
    tagIds: [...new Set([...(filter.tagIds ?? []), tagId])],
  }));
}

/** The viewer's hidden users, those they blocked and those who blocked them: never candidates. */
export function viewerExcludedUserIds(hidden: {
  hiddenUsers: { id: number }[];
  blockedUsers: { id: number }[];
  blockedByUsers: { id: number }[];
}) {
  return [
    ...new Set(
      [...hidden.hiddenUsers, ...hidden.blockedUsers, ...hidden.blockedByUsers].map((x) => x.id)
    ),
  ];
}

/**
 * Candidates for a text query, with the service's spelling correction audited as well: the service
 * embeds its correction, not the text the caller audited. `audit` returns a truthy refusal; a
 * refused correction ends the search, and `state.refused` tells the caller to return nothing.
 */
export function auditedTextCandidates({
  source,
  text,
  filter,
  viewer,
  audit,
}: {
  source: CandidateSource;
  text: string;
  filter: CandidateFilter;
  viewer: SearchViewer;
  audit: (correction: string) => Promise<unknown>;
}) {
  const state = {
    correctedQuery: undefined as string | undefined,
    refused: false,
    returned: 0,
    // The first call's: every call of one search carries the same query.
    first: undefined as { ids: number[]; guard?: GuardRead; cacheHit?: boolean } | undefined,
  };
  let audited = false;
  const candidates = async (offset: number, limit: number) => {
    const result = await source({ query: { text }, filter, offset, limit, viewer });
    state.first ??= { ids: result.ids, guard: result.guard, cacheHit: result.cacheHit };
    if (!audited && result.correctedQuery !== undefined) {
      audited = true;
      state.refused = result.correctedQuery !== text && !!(await audit(result.correctedQuery));
    }
    if (state.refused) return [];
    state.correctedQuery ??= result.correctedQuery;
    state.returned += result.ids.length;
    return result.ids;
  };
  return { candidates, state };
}

export type Hydrate<T extends { id: number }> = (ids: number[]) => Promise<T[]>;

/**
 * Pages through ranked candidates, keeping those the page's own fetch path returns, in candidate
 * order. Qdrant's payload can be stale, so it only proposes: whatever hydration drops never reaches
 * the page.
 */
export async function collectPage<T extends { id: number }>({
  candidates,
  hydrate,
  offset,
  limit,
  excluded = new Set(),
}: {
  candidates: (offset: number, limit: number) => Promise<number[]>;
  hydrate: Hydrate<T>;
  offset: number;
  limit: number;
  excluded?: Set<number>;
}) {
  const items: T[] = [];
  const kept = new Set<number>();
  let position = offset;
  let exhausted = false;

  for (let round = 0; round < MAX_HYDRATION_ROUNDS && items.length < limit; round++) {
    const batchSize = Math.min(
      (limit - items.length) * CANDIDATE_MULTIPLIER,
      MAX_CANDIDATE_LIMIT,
      MAX_CANDIDATE_OFFSET - position
    );
    if (batchSize <= 0) {
      exhausted = true;
      break;
    }
    const ids = await candidates(position, batchSize);
    const wanted = ids.filter((id) => !excluded.has(id));
    const byId = new Map((wanted.length ? await hydrate(wanted) : []).map((x) => [x.id, x]));

    let consumed = 0;
    for (const id of ids) {
      if (items.length >= limit) break;
      consumed++;
      const item = byId.get(id);
      // Ties in the ranking reorder between requests, so a later round can repeat an earlier id.
      if (!item || excluded.has(id) || kept.has(id)) continue;
      kept.add(id);
      items.push(item);
    }
    position += consumed;
    if (ids.length < batchSize && consumed === ids.length) {
      exhausted = true;
      break;
    }
  }

  const nextCursor = !exhausted && position < MAX_CANDIDATE_OFFSET ? position : undefined;
  return { items, nextCursor };
}

/** Tag names, as search URLs and pickers carry them, to ids; a name that does not exist is dropped. */
/** Tag names (case-insensitively) to the tags they name; a name that does not exist is absent. */
export async function resolveTags(names: string[]) {
  return dbRead.tag.findMany({
    where: { name: { in: names.map((name) => name.toLowerCase()) } },
    select: { id: true, name: true },
  });
}

export async function resolveTagIds(names: string[]) {
  return (await resolveTags(names)).map((x) => x.id);
}

/** Usernames to user ids; a name that does not exist is dropped. */
export async function resolveUserIds(usernames: string[]) {
  const users = await dbRead.user.findMany({
    where: { username: { in: usernames } },
    select: { id: true },
  });
  return users.map((x) => x.id);
}
