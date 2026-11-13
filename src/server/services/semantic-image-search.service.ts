import { TRPCError } from '@trpc/server';
import type { SemanticImageSearchInput } from '~/server/schema/semantic-image-search.schema';
import { getInfiniteImagesSchema } from '~/server/schema/image.schema';
import { getAllImages } from '~/server/services/image.service';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { getBlockedBrowsingTags, getBrowsingSettingAddons } from '~/server/services/system-cache';
import { stripBlockedTagIds } from '~/server/utils/blocked-browsing-tags';
import { ImageSort } from '~/server/common/enums';
import { nsfwRestrictedBaseModels } from '~/server/common/constants';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  anchorBrowsingLevel,
  queryVerdictLevel,
  recordRefusal,
  isNonModClampOn,
  resolveSemanticBrowsingLevel,
  semanticQueryRefusal,
  type QueryRefusal,
  type QueryStage,
  type QueryTracker,
} from '~/server/services/semantic-query-guard';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import {
  nsfwBrowsingLevelsArray,
  nsfwBrowsingLevelsFlag,
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

const emptyPage = () => ({ items: [], nextCursor: undefined, correctedQuery: undefined });

export async function searchSemanticImages({
  input,
  user,
  domain,
  track,
  candidateSource = searchServiceCandidates,
}: {
  input: SemanticImageSearchInput;
  // Signed out: the site defaults for hidden tags and browsing add-ons.
  user?: SessionUser;
  domain?: DomainColor;
  track?: QueryTracker;
  candidateSource?: CandidateSource;
}) {
  let browsingLevel = resolveSemanticBrowsingLevel(
    input.browsingLevel,
    user,
    await isNonModClampOn()
  );

  const [hidden, addonData, blockedTags, namedUserIds, namedTagIds] = await Promise.all([
    getAllHiddenForUser({ userId: user?.id }),
    getBrowsingSettingAddons(),
    getBlockedBrowsingTags(),
    input.usernames?.length ? resolveUserIds(input.usernames) : undefined,
    input.tagNames?.length ? resolveTagIds(input.tagNames) : undefined,
  ]);
  // The feed's user and a typed @user are two filters, so both must hold.
  const userIds =
    namedUserIds && input.userIds?.length
      ? namedUserIds.filter((id) => input.userIds?.includes(id))
      : namedUserIds ?? (input.userIds?.length ? input.userIds : undefined);
  if (userIds && !userIds.length) return emptyPage();
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
  const addonsFor = (level: number) =>
    resolveBrowsingSettingsAddons(addonData, level, { isModerator: user?.isModerator });
  let addons = addonsFor(browsingLevel);
  const refusalOf = async (text: string, stage: QueryStage) => {
    const refusal = await semanticQueryRefusal(text, {
      browsingLevel,
      disablePoi: addons.disablePoi,
      isModerator: user?.isModerator,
    });
    recordRefusal(track, refusal, text, 'images_semantic', stage);
    return refusal;
  };
  const refusal = input.query ? await refusalOf(input.query, 'query') : false;
  const verdictLevel = queryVerdictLevel(refusal, browsingLevel, user?.isModerator);
  if (verdictLevel === 'refuse') return emptyPage();
  if (verdictLevel !== browsingLevel) {
    browsingLevel = verdictLevel;
    addons = addonsFor(browsingLevel);
  }
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

  // The feed's own fetch path decides visibility (publish state, privacy, blocks, moderation,
  // browsing level, hidden users and tags); Qdrant only proposes candidates.
  const fetchVisible = async (
    ids: number[],
    level: number,
    filters: { tags?: number[]; excludedTagIds: number[] }
  ) => {
    const { items } = await getAllImages({
      ...getInfiniteImagesSchema.parse({
        ids,
        limit: ids.length,
        sort: ImageSort.Newest,
        browsingLevel: level,
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

  // "More like this" from an image the viewer cannot see would reveal what it resembles.
  let level = browsingLevel;
  if (input.imageId) {
    const [anchor] = await fetchVisible([input.imageId], browsingLevel, {
      excludedTagIds: viewerExcludedTagIds,
    });
    if (!anchor) throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found' });
    if (!user?.isModerator && !(await isFlipt(FLIPT_FEATURE_FLAGS.SEMANTIC_SIMILAR_ANCHOR_CAP_OFF)))
      level = anchorBrowsingLevel(browsingLevel, anchor.nsfwLevel);
  }
  const hydrate: Hydrate<HydratedImage> = (ids) =>
    fetchVisible(ids, level, { tags: tagIds, excludedTagIds });

  // Hidden tags, users and images are left to hydration and `excluded` below: as Qdrant must_nots
  // they cost over a second per search on the on-disk payload, and hydration enforces them anyway.
  const filter: CandidateFilter = {
    gate: {
      kind: 'level',
      nsfwLevels: Flags.instanceToArray(level),
    },
    tagIds,
    anyOf: { baseModels: input.baseModels, type: input.types },
    userIds,
    range: {
      key: 'sortAt',
      gte: input.postedAfter?.toISOString(),
      lte: input.postedBefore?.toISOString(),
    },
    // As the image search index: no NSFW images made with a base model whose license forbids it.
    // A gate with no NSFW level already excludes them, and Qdrant would still test every candidate.
    // Kept here, not only in hydration: Image."modelRestricted" is set by an hourly job, so a new
    // image would pass hydration until it runs.
    mustNot: Flags.intersects(level, nsfwBrowsingLevelsFlag)
      ? [
          {
            must: [
              { key: 'nsfwLevel', match: { any: nsfwBrowsingLevelsArray } },
              { key: 'baseModels', match: { any: nsfwRestrictedBaseModels } },
            ],
          },
        ]
      : [],
  };

  const query: SearchQuery = input.imageId
    ? { similarTo: input.imageId }
    : { text: input.query ?? '' };

  let correctedQuery: string | undefined;
  let correctedRefusal: QueryRefusal | undefined;
  const page = await collectPage({
    candidates: async (offset, limit) => {
      const result = await candidateSource({ query, filter, offset, limit, sort: input.sort });
      // The service embeds its spelling correction, not the text audited above.
      if (correctedRefusal === undefined && result.correctedQuery !== undefined)
        correctedRefusal =
          result.correctedQuery !== input.query &&
          (await refusalOf(result.correctedQuery, 'correction'));
      if (correctedRefusal) return [];
      correctedQuery ??= result.correctedQuery;
      return result.ids;
    },
    hydrate,
    offset: input.cursor ?? 0,
    limit: input.limit,
    excluded: new Set([...excludedImageIds, ...(input.imageId ? [input.imageId] : [])]),
  });
  if (correctedRefusal) return emptyPage();
  return { ...page, correctedQuery };
}
