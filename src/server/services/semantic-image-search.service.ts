import { TRPCError } from '@trpc/server';
import type { SemanticImageSearchInput } from '~/server/schema/semantic-image-search.schema';
import { getInfiniteImagesSchema } from '~/server/schema/image.schema';
import { getAllImages } from '~/server/services/image.service';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { getBlockedBrowsingTags, getBrowsingSettingAddons } from '~/server/services/system-cache';
import { stripBlockedTagIds } from '~/server/utils/blocked-browsing-tags';
import { ImageSort } from '~/server/common/enums';
import { nsfwRestrictedBaseModels } from '~/server/common/constants';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import {
  nsfwBrowsingLevelsArray,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import type { DomainColor } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';
import {
  collectPage,
  resolveTagIds,
  resolveUserIds,
  searchServiceSource,
  type CandidateFilter,
  type CandidateSource,
  type Hydrate,
  type SearchQuery,
} from '~/server/services/semantic-search-client';

// The search service's collection name for the image vectors.
const IMAGE_COLLECTION = 'images';

type HydratedImage = Awaited<ReturnType<typeof getAllImages>>['items'][number];

const searchServiceCandidates = searchServiceSource(IMAGE_COLLECTION, {
  notFoundMessage: 'Image not found',
});

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
  const [hidden, addonData, blockedTags, userIds, namedTagIds] = await Promise.all([
    getAllHiddenForUser({ userId: user?.id }),
    getBrowsingSettingAddons(),
    getBlockedBrowsingTags(),
    input.usernames?.length ? resolveUserIds(input.usernames) : undefined,
    input.tagNames?.length ? resolveTagIds(input.tagNames) : undefined,
  ]);
  if (userIds && !userIds.length)
    return { items: [], nextCursor: undefined, correctedQuery: undefined };
  // As the image feed: a tag that cannot be browsed is dropped, and a filter of only such tags is empty.
  // A named tag that does not exist can match nothing.
  if (namedTagIds && namedTagIds.length < new Set(input.tagNames).size)
    return { items: [], nextCursor: undefined, correctedQuery: undefined };
  const strip = stripBlockedTagIds(
    [...new Set([...(input.tagIds ?? []), ...(namedTagIds ?? [])])],
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
    gate: {
      kind: 'level',
      nsfwLevels: Flags.instanceToArray(input.browsingLevel || publicBrowsingLevelsFlag),
    },
    tagIds,
    excludedTagIds,
    anyOf: { baseModels: input.baseModels, type: input.types },
    userIds,
    range: {
      key: 'sortAt',
      gte: input.postedAfter?.toISOString(),
      lte: input.postedBefore?.toISOString(),
    },
    excludedUserIds,
    excludedIds: excludedImageIds,
    // As the image search index: no NSFW images made with a base model whose license forbids it.
    mustNot: [
      {
        must: [
          { key: 'nsfwLevel', match: { any: nsfwBrowsingLevelsArray } },
          { key: 'baseModels', match: { any: nsfwRestrictedBaseModels } },
        ],
      },
    ],
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
  const hydrate: Hydrate<HydratedImage> = (ids) =>
    fetchVisible(ids, { tags: tagIds, excludedTagIds });

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
