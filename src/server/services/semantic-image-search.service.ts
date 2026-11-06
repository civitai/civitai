import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import type { SemanticImageSearchInput } from '~/server/schema/semantic-image-search.schema';
import { getInfiniteImagesSchema } from '~/server/schema/image.schema';
import { getAllImages } from '~/server/services/image.service';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { getBlockedBrowsingTags, getBrowsingSettingAddons } from '~/server/services/system-cache';
import { stripBlockedTagIds } from '~/server/utils/blocked-browsing-tags';
import { ImageSort } from '~/server/common/enums';
import { nsfwRestrictedBaseModels } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import {
  nsfwBrowsingLevelsArray,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import type { DomainColor } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

const CANDIDATE_MULTIPLIER = 3;
const MAX_HYDRATION_ROUNDS = 3;
// The ceiling of an `ids` batch on the image fetch path (IMAGE_IDS_BATCH_CAP's reasoning).
const MAX_HYDRATION_BATCH = 100;
// The search service's paging cap.
export const MAX_CANDIDATE_OFFSET = 2000;
// The search service's collection name for the image vectors.
const IMAGE_COLLECTION = 'images';
// A filter shape Qdrant has not served recently can take 10 s on its first query (vectors, graph
// and payload indexes are on disk), then well under 1 s.
const SEARCH_SERVICE_TIMEOUT_MS = 20_000;

type HydratedImage = Awaited<ReturnType<typeof getAllImages>>['items'][number];

export type SearchQuery = { text: string } | { similarTo: number };

/** Viewer policy and the chosen filters, decided here; the search service applies them as given. */
export type CandidateFilter = {
  nsfwLevels: number[];
  tagIds?: number[];
  excludedTagIds?: number[];
  baseModels?: string[];
  types?: string[];
  userIds?: number[];
  excludedUserIds?: number[];
  excludedImageIds?: number[];
  postedAfter?: string;
  postedBefore?: string;
  // Images at these NSFW levels made with any of these base models are excluded.
  restrictedBaseModels?: { nsfwLevels: number[]; baseModels: string[] };
};

export function buildQdrantFilter(f: CandidateFilter) {
  const must: Record<string, unknown>[] = [{ key: 'nsfwLevel', match: { any: f.nsfwLevels } }];
  // Every listed tag, not any of them: each added tag narrows the results.
  for (const tagId of f.tagIds ?? []) must.push({ key: 'tagIds', match: { value: tagId } });
  if (f.baseModels?.length) must.push({ key: 'baseModels', match: { any: f.baseModels } });
  if (f.types?.length) must.push({ key: 'type', match: { any: f.types } });
  if (f.userIds?.length) must.push({ key: 'userId', match: { any: f.userIds } });
  if (f.postedAfter || f.postedBefore)
    must.push({ key: 'sortAt', range: { gte: f.postedAfter, lte: f.postedBefore } });

  const must_not: Record<string, unknown>[] = [];
  if (f.excludedTagIds?.length) must_not.push({ key: 'tagIds', match: { any: f.excludedTagIds } });
  if (f.excludedUserIds?.length)
    must_not.push({ key: 'userId', match: { any: f.excludedUserIds } });
  if (f.excludedImageIds?.length) must_not.push({ has_id: f.excludedImageIds });
  if (f.restrictedBaseModels)
    must_not.push({
      must: [
        { key: 'nsfwLevel', match: { any: f.restrictedBaseModels.nsfwLevels } },
        { key: 'baseModels', match: { any: f.restrictedBaseModels.baseModels } },
      ],
    });

  return { must, must_not };
}

/** Ranked image ids, and the query as the service's spelling correction rewrote it, if it did. */
export type CandidateSource = (args: {
  query: SearchQuery;
  filter: CandidateFilter;
  offset: number;
  limit: number;
}) => Promise<{ ids: number[]; correctedQuery?: string }>;

async function searchServiceRequest<T>(path: string, body: unknown): Promise<T> {
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
  // Only "more like this" can 404: the image is not in the index.
  if (res.status === 404) throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found' });
  if (!res.ok)
    throw new TRPCError({ code: 'BAD_GATEWAY', message: `Search service error (${res.status})` });
  return (await res.json()) as T;
}

/**
 * The cluster search service: text through `/v1/search` (embedding and spelling correction are
 * its job), "more like this" through its read-only Qdrant pass-through. Ids only, never payload:
 * the index lags Postgres, so hydration decides what is shown.
 */
const searchServiceCandidates: CandidateSource = async ({ query, filter, offset, limit }) => {
  const qdrantFilter = buildQdrantFilter(filter);
  if ('similarTo' in query) {
    // The source image is always its own best match.
    qdrantFilter.must_not.push({ has_id: [query.similarTo] });
    const { result } = await searchServiceRequest<{
      result: { points: { id: number | string }[] };
    }>(`/qdrant/collections/${IMAGE_COLLECTION}/points/query`, {
      query: query.similarTo,
      filter: qdrantFilter,
      offset,
      limit,
      params: { quantization: { rescore: true, oversampling: 2 } },
      with_payload: false,
    });
    return { ids: result.points.map((p) => Number(p.id)) };
  }

  const { corrected, changes, hits } = await searchServiceRequest<{
    corrected: string;
    changes: unknown[];
    hits: { id: number | string }[];
  }>('/v1/search', {
    collection: IMAGE_COLLECTION,
    query: query.text,
    filter: qdrantFilter,
    offset,
    limit,
  });
  return {
    ids: hits.map((h) => Number(h.id)),
    correctedQuery: changes.length ? corrected : undefined,
  };
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

async function resolveUserIds(usernames: string[]) {
  const users = await dbRead.user.findMany({
    where: { username: { in: usernames } },
    select: { id: true },
  });
  return users.map((x) => x.id);
}

export async function searchSemanticImages({
  input,
  user,
  domain,
  candidateSource = searchServiceCandidates,
}: {
  input: SemanticImageSearchInput;
  // Signed out: the site defaults for hidden tags and browsing add-ons.
  user?: SessionUser;
  domain?: DomainColor;
  candidateSource?: CandidateSource;
}) {
  const [hidden, addonData, blockedTags, userIds] = await Promise.all([
    getAllHiddenForUser({ userId: user?.id }),
    getBrowsingSettingAddons(),
    getBlockedBrowsingTags(),
    input.usernames?.length ? resolveUserIds(input.usernames) : undefined,
  ]);
  if (userIds && !userIds.length)
    return { items: [], nextCursor: undefined, correctedQuery: undefined };
  // As the image feed: a tag that cannot be browsed is dropped, and a filter of only such tags is empty.
  const strip = stripBlockedTagIds(
    input.tagIds,
    blockedTags.map((t) => t.id)
  );
  if (strip.emptyResult) return { items: [], nextCursor: undefined, correctedQuery: undefined };
  const tagIds = strip.tagIds;
  // The feed applies these in the browser; here they are applied server-side.
  const addons = resolveBrowsingSettingsAddons(addonData, input.browsingLevel, {
    isModerator: user?.isModerator,
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

  const filter: CandidateFilter = {
    nsfwLevels: Flags.instanceToArray(input.browsingLevel || publicBrowsingLevelsFlag),
    tagIds,
    excludedTagIds,
    baseModels: input.baseModels,
    types: input.types,
    userIds,
    postedAfter: input.postedAfter?.toISOString(),
    postedBefore: input.postedBefore?.toISOString(),
    excludedUserIds,
    excludedImageIds,
    // As the image search index: no NSFW images made with a base model whose license forbids it.
    restrictedBaseModels: {
      nsfwLevels: nsfwBrowsingLevelsArray,
      baseModels: nsfwRestrictedBaseModels,
    },
  };

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
  const query: SearchQuery = input.imageId
    ? { similarTo: input.imageId }
    : { text: input.query ?? '' };

  let correctedQuery: string | undefined;
  const page = await collectPage({
    candidates: async (offset, limit) => {
      const result = await candidateSource({ query, filter, offset, limit });
      correctedQuery ??= result.correctedQuery;
      return result.ids;
    },
    hydrate,
    offset: input.cursor ?? 0,
    limit: input.limit,
    excluded: new Set([...excludedImageIds, ...(input.imageId ? [input.imageId] : [])]),
  });
  return { ...page, correctedQuery };
}
