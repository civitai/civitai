import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';

const CANDIDATE_MULTIPLIER = 3;
const MAX_HYDRATION_ROUNDS = 3;
// Most candidates hydrated per round: each round is one id-list query on the page's fetch path.
const MAX_HYDRATION_BATCH = 100;
// The search service's paging cap.
export const MAX_CANDIDATE_OFFSET = 2000;
// A filter shape Qdrant has not served recently can take 10 s on its first query (vectors, graph
// and payload indexes are on disk), then well under 1 s.
const SEARCH_SERVICE_TIMEOUT_MS = 20_000;

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
  comics: 'level',
  models3d: 'level',
  storylines: 'level',
  challenges: 'challenge',
  crucibles: 'crucible',
} as const satisfies Record<string, ViewerGate['kind']>;

export type SearchCollection = keyof typeof GATE_KIND;

export type SearchQuery = { text: string } | { similarTo: number };

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
  excludedIds?: number[];
  // Payload key → the point matches any of the values.
  anyOf?: Record<string, PayloadValue[] | undefined>;
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

/** Ranked ids, and the query as the service's spelling correction rewrote it, if it did. */
export type CandidateSource = (args: {
  query: SearchQuery;
  filter: CandidateFilter;
  offset: number;
  limit: number;
}) => Promise<{ ids: number[]; correctedQuery?: string }>;

async function searchServiceRequest<T>(path: string, body: unknown, notFound: string): Promise<T> {
  if (!env.SEARCH_SERVICE_URL)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Semantic search is not set up' });
  const res = await fetch(`${env.SEARCH_SERVICE_URL.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.SEARCH_SERVICE_TOKEN ? { authorization: `Bearer ${env.SEARCH_SERVICE_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEARCH_SERVICE_TIMEOUT_MS),
  }).catch((err) => {
    throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Search is unavailable', cause: err });
  });
  // Only "more like this" can 404: the source is not in the index.
  if (res.status === 404) throw new TRPCError({ code: 'NOT_FOUND', message: notFound });
  if (!res.ok)
    throw new TRPCError({ code: 'BAD_GATEWAY', message: `Search service error (${res.status})` });
  return (await res.json()) as T;
}

/**
 * The cluster search service: text through `/v1/search` (embedding and spelling correction are
 * its job), "more like this" through its read-only Qdrant pass-through. Ids only, never payload:
 * the index lags Postgres, so hydration decides what is shown.
 */
export function searchServiceSource(
  collection: SearchCollection,
  { notFoundMessage = 'Not found' }: { notFoundMessage?: string } = {}
): CandidateSource {
  return async ({ query, filter, offset, limit }) => {
    const qdrantFilter = buildQdrantFilter(collection, filter);
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
        notFoundMessage
      );
      return { ids: result.points.map((p) => Number(p.id)) };
    }

    const { corrected, changes, hits } = await searchServiceRequest<{
      corrected: string;
      changes: unknown[];
      hits: { id: number | string }[];
    }>(
      '/v1/search',
      { collection, query: query.text, filter: qdrantFilter, offset, limit },
      notFoundMessage
    );
    return {
      ids: hits.map((h) => Number(h.id)),
      correctedQuery: changes.length ? corrected : undefined,
    };
  };
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
      MAX_HYDRATION_BATCH,
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
export async function resolveTagIds(names: string[]) {
  const tags = await dbRead.tag.findMany({
    where: { name: { in: names.map((name) => name.toLowerCase()) } },
    select: { id: true },
  });
  return tags.map((x) => x.id);
}

/** Usernames to user ids; a name that does not exist is dropped. */
export async function resolveUserIds(usernames: string[]) {
  const users = await dbRead.user.findMany({
    where: { username: { in: usernames } },
    select: { id: true },
  });
  return users.map((x) => x.id);
}
