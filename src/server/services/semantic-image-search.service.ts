import { createHash } from 'crypto';
import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import type { SemanticImageSearchInput } from '~/server/schema/semantic-image-search.schema';
import { getInfiniteImagesSchema } from '~/server/schema/image.schema';
import { getAllImages } from '~/server/services/image.service';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { getBlockedBrowsingTags, getBrowsingSettingAddons } from '~/server/services/system-cache';
import { stripBlockedTagIds } from '~/server/utils/blocked-browsing-tags';
import { ImageSort } from '~/server/common/enums';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import type { DomainColor } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

// The index contract lives in docs/features/semantic-image-search.md; these mirror it.
const VECTOR_ALIAS = 'images_semantic';
const EMBED_MODEL = 'wemm-2b';
const EMBED_DIMENSIONS = 256;

const QUERY_VECTOR_TTL = 60 * 60 * 24 * 7;
const CANDIDATE_MULTIPLIER = 3;
const MAX_HYDRATION_ROUNDS = 3;
// The ceiling of an `ids` batch on the image fetch path (IMAGE_IDS_BATCH_CAP's reasoning).
const MAX_HYDRATION_BATCH = 100;
// Qdrant pays for every skipped candidate on each page, so deep paging is capped.
export const MAX_CANDIDATE_OFFSET = 2000;

type ModelStamp = { model?: string; dimensions?: number; modelRevision?: string; profile?: string };
type HydratedImage = Awaited<ReturnType<typeof getAllImages>>['items'][number];

async function qdrantRequest<T>(path: string, body?: unknown): Promise<T> {
  if (!env.QDRANT_URL)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Semantic search is not set up' });
  const res = await fetch(`${env.QDRANT_URL}/collections/${VECTOR_ALIAS}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(env.QDRANT_API_KEY ? { 'api-key': env.QDRANT_API_KEY } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok)
    throw new TRPCError({ code: 'BAD_GATEWAY', message: `Vector index error (${res.status})` });
  const { result } = (await res.json()) as { result: T };
  return result;
}

let stampCache: { stamp: ModelStamp; at: number } | undefined;
async function getIndexStamp(): Promise<ModelStamp> {
  if (stampCache && Date.now() - stampCache.at < 5 * 60 * 1000) return stampCache.stamp;
  const info = await qdrantRequest<{ config: { metadata?: ModelStamp } }>('');
  const stamp = info.config.metadata ?? {};
  stampCache = { stamp, at: Date.now() };
  return stamp;
}

/** Whitespace only: case can carry meaning (names, styles), so it reaches the model unchanged. */
export function normalizeQuery(query: string) {
  return query.trim().replace(/\s+/g, ' ');
}

type EmbeddingOutput = ModelStamp & { data?: { embedding: number[] }[] };

async function embedQuery(text: string) {
  const stamp = await getIndexStamp();
  if (!stamp.modelRevision)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'The index has no vectors yet' });

  const hash = createHash('sha256').update(text).digest('hex');
  const key =
    `${REDIS_KEYS.SEMANTIC_SEARCH.QUERY_VECTOR}:${EMBED_MODEL}:${EMBED_DIMENSIONS}:${stamp.modelRevision}:${stamp.profile}:${hash}` as const;
  const cached = await redis.packed.get<number[]>(key);
  if (cached) return cached;

  const { data, error } = await internalOrchestratorClient.post<{ 200: EmbeddingOutput }>({
    url: '/v2/consumer/recipes/multimodalEmbedding',
    body: { model: EMBED_MODEL, dimensions: EMBED_DIMENSIONS, inputs: [{ id: 'q', text }] },
    headers: { 'Content-Type': 'application/json' },
  });
  const vector = data?.data?.[0]?.embedding;
  if (error || !vector) throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Embedding failed' });
  // A query vector from another model or profile is meaningless against the index.
  if (data.modelRevision !== stamp.modelRevision || data.profile !== stamp.profile) {
    stampCache = undefined;
    void logToAxiom({
      name: 'semantic-search:model-mismatch',
      type: 'error',
      details: { query: data.modelRevision, queryProfile: data.profile, index: stamp },
    }).catch(() => undefined);
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The search model does not match the index',
    });
  }

  await redis.packed.set(key, vector, { EX: QUERY_VECTOR_TTL });
  return vector;
}

type CandidateFilter = {
  browsingLevel: number;
  tagIds?: number[];
  excludedTagIds?: number[];
  baseModels?: string[];
  types?: string[];
  excludedUserIds?: number[];
  excludedImageIds?: number[];
};

export function buildCandidateFilter(f: CandidateFilter) {
  const must: Record<string, unknown>[] = [
    {
      key: 'nsfwLevel',
      match: { any: Flags.instanceToArray(f.browsingLevel || publicBrowsingLevelsFlag) },
    },
  ];
  // Every listed tag, not any of them: each added tag narrows the results.
  for (const tagId of f.tagIds ?? []) must.push({ key: 'tagIds', match: { value: tagId } });
  if (f.baseModels?.length) must.push({ key: 'baseModels', match: { any: f.baseModels } });
  if (f.types?.length) must.push({ key: 'type', match: { any: f.types } });

  const must_not: Record<string, unknown>[] = [];
  if (f.excludedTagIds?.length) must_not.push({ key: 'tagIds', match: { any: f.excludedTagIds } });
  if (f.excludedUserIds?.length)
    must_not.push({ key: 'userId', match: { any: f.excludedUserIds } });
  if (f.excludedImageIds?.length) must_not.push({ has_id: f.excludedImageIds });

  return { must, must_not };
}

export type CandidateSource = (args: {
  query: number[] | number;
  filter: ReturnType<typeof buildCandidateFilter>;
  offset: number;
  limit: number;
}) => Promise<number[]>;

const qdrantCandidates: CandidateSource = async ({ query, filter, offset, limit }) => {
  const { points } = await qdrantRequest<{ points: { id: number | string }[] }>('/points/query', {
    query,
    filter,
    offset,
    limit,
    params: { quantization: { rescore: true, oversampling: 2 } },
    with_payload: false,
  });
  return points.map((p) => Number(p.id));
};

export type Hydrate = (ids: number[]) => Promise<HydratedImage[]>;

/**
 * Pages through ranked candidates, keeping those the image fetch path returns, in candidate order.
 * Qdrant's payload can be stale, so it only proposes: whatever hydration drops never reaches the page.
 */
export async function collectPage({
  candidates,
  hydrate,
  offset,
  limit,
  excluded = new Set(),
}: {
  candidates: (offset: number, limit: number) => Promise<number[]>;
  hydrate: Hydrate;
  offset: number;
  limit: number;
  excluded?: Set<number>;
}) {
  const items: HydratedImage[] = [];
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
      if (item && !excluded.has(id)) items.push(item);
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

export async function searchSemanticImages({
  input,
  user,
  domain,
  candidateSource = qdrantCandidates,
}: {
  input: SemanticImageSearchInput;
  user: SessionUser;
  domain?: DomainColor;
  candidateSource?: CandidateSource;
}) {
  const [hidden, addonData, blockedTags] = await Promise.all([
    getAllHiddenForUser({ userId: user.id }),
    getBrowsingSettingAddons(),
    getBlockedBrowsingTags(),
  ]);
  // As the image feed: a tag that cannot be browsed is dropped, and a filter of only such tags is empty.
  const strip = stripBlockedTagIds(
    input.tagIds,
    blockedTags.map((t) => t.id)
  );
  if (strip.emptyResult) return { items: [], nextCursor: undefined };
  const tagIds = strip.tagIds;
  // The feed applies these in the browser; here they are applied server-side.
  const addons = resolveBrowsingSettingsAddons(addonData, input.browsingLevel, {
    isModerator: user.isModerator,
  });
  const excludedUserIds = [
    ...new Set(
      [...hidden.hiddenUsers, ...hidden.blockedUsers, ...hidden.blockedByUsers].map((x) => x.id)
    ),
  ];
  const hiddenTagIds = hidden.hiddenTags.filter((x) => x.hidden).map((x) => x.id);
  const viewerExcludedTagIds = [...new Set([...addons.excludedTagIds, ...hiddenTagIds])];
  const excludedTagIds = [...new Set([...(input.excludedTagIds ?? []), ...viewerExcludedTagIds])];
  // As applyUserPreferences: an image hidden through a tag vote counts only while that tag is hidden.
  const excludedImageIds = hidden.hiddenImages
    .filter((x) => !x.tagId || hiddenTagIds.includes(x.tagId))
    .map((x) => x.id);

  const filter = buildCandidateFilter({
    browsingLevel: input.browsingLevel,
    tagIds,
    excludedTagIds,
    baseModels: input.baseModels,
    types: input.types,
    excludedUserIds,
    excludedImageIds,
  });

  // The feed's own fetch path decides visibility (publish state, privacy, blocks, moderation,
  // browsing level, hidden users and tags); Qdrant only proposes candidates.
  const fetchVisible = async (
    ids: number[],
    filters: { tags?: number[]; excludedTagIds: number[] }
  ) => {
    const { items } = await getAllImages({
      ...getInfiniteImagesSchema.parse({
        ids,
        limit: ids.length,
        sort: ImageSort.Newest,
        browsingLevel: input.browsingLevel,
        ...filters,
        excludedUserIds,
        disablePoi: addons.disablePoi,
        disableMinor: addons.disableMinor,
        include: ['cosmetics', 'tagIds'],
      }),
      user,
      domain,
      headers: { src: 'semanticImageSearch' },
    });
    return items;
  };
  const hydrate: Hydrate = (ids) => fetchVisible(ids, { tags: tagIds, excludedTagIds });

  // "More like this" from an image the viewer cannot see would reveal what it resembles.
  if (input.imageId) {
    const [anchor] = await fetchVisible([input.imageId], { excludedTagIds: viewerExcludedTagIds });
    if (!anchor) throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found' });
  }
  const query = input.imageId ?? (await embedQuery(normalizeQuery(input.query ?? '')));

  return collectPage({
    candidates: (offset, limit) => candidateSource({ query, filter, offset, limit }),
    hydrate,
    offset: input.cursor ?? 0,
    limit: input.limit,
    excluded: new Set([...excludedImageIds, ...(input.imageId ? [input.imageId] : [])]),
  });
}
