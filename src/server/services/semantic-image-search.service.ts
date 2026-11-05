import { TRPCError } from '@trpc/server';
import {
  createSearchClient,
  SearchServiceError,
  type ImageSearchFilter,
  type ImageSearchQuery,
} from '@civitai/search';
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
// The search service's paging cap (IMAGE_SEARCH_MAX_OFFSET).
export const MAX_CANDIDATE_OFFSET = 2000;

type HydratedImage = Awaited<ReturnType<typeof getAllImages>>['items'][number];

export type CandidateSource = (args: {
  query: ImageSearchQuery;
  filter: ImageSearchFilter;
  offset: number;
  limit: number;
}) => Promise<number[]>;

const TRPC_CODE_BY_SERVICE_CODE = {
  invalid: 'BAD_REQUEST',
  unauthorized: 'INTERNAL_SERVER_ERROR',
  'not-found': 'NOT_FOUND',
  'not-ready': 'PRECONDITION_FAILED',
  upstream: 'BAD_GATEWAY',
  unavailable: 'BAD_GATEWAY',
} as const;

let searchClient: ReturnType<typeof createSearchClient> | undefined;
const serviceCandidates: CandidateSource = async (args) => {
  if (!env.SEARCH_SERVICE_URL)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Semantic search is not set up' });
  searchClient ??= createSearchClient({
    endpoint: env.SEARCH_SERVICE_URL,
    token: env.SEARCH_SERVICE_TOKEN,
  });
  try {
    const { ids } = await searchClient.images.search(args);
    return ids;
  } catch (err) {
    if (!(err instanceof SearchServiceError)) throw err;
    throw new TRPCError({
      code: TRPC_CODE_BY_SERVICE_CODE[err.code],
      message: err.code === 'not-found' ? 'Image not found' : err.message,
    });
  }
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
  candidateSource = serviceCandidates,
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
  if (userIds && !userIds.length) return { items: [], nextCursor: undefined };
  // As the image feed: a tag that cannot be browsed is dropped, and a filter of only such tags is empty.
  const strip = stripBlockedTagIds(
    input.tagIds,
    blockedTags.map((t) => t.id)
  );
  if (strip.emptyResult) return { items: [], nextCursor: undefined };
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

  const filter: ImageSearchFilter = {
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
  const query: ImageSearchQuery = input.imageId
    ? { similarTo: input.imageId }
    : { text: input.query ?? '' };

  return collectPage({
    candidates: (offset, limit) => candidateSource({ query, filter, offset, limit }),
    hydrate,
    offset: input.cursor ?? 0,
    limit: input.limit,
    excluded: new Set([...excludedImageIds, ...(input.imageId ? [input.imageId] : [])]),
  });
}
