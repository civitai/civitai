import { TRPCError } from '@trpc/server';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import type { SemanticImageSearchInput } from '~/server/schema/semantic-image-search.schema';
import { getInfiniteImagesSchema } from '~/server/schema/image.schema';
import { getAllImages } from '~/server/services/image.service';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { getBlockedBrowsingTags, getBrowsingSettingAddons } from '~/server/services/system-cache';
import { stripBlockedTagIds } from '~/server/utils/blocked-browsing-tags';
import { ImageSort } from '~/server/common/enums';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  anchorBrowsingLevel,
  beginSemanticAudit,
  isNonModClampOn,
  makeRefusalOf,
  type QueryRefusal,
  type QueryTracker,
  queryVerdictLevel,
  refusedTextCandidates,
  resolveSemanticBrowsingLevel,
} from '~/server/services/semantic-query-guard';
import { withCandidateCache } from '~/server/services/semantic-candidate-cache';
import type { RefusedCandidates } from '~/server/services/semantic-search-audit.service';
import { semanticSearchStage } from '~/server/metrics/semantic-search.metrics';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import { Flags } from '~/shared/utils/flags';
import type { DomainColor } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';
import { sleep } from '~/server/utils/concurrency-helpers';
import {
  collectPage,
  resolveTagIds,
  resolveUserIds,
  searchServiceSource,
  type CandidateFilter,
  type CandidateSource,
  type Hydrate,
  type SearchQuery,
  viewerExcludedUserIds,
} from '~/server/services/semantic-search-client';

// The search service's collection name for the image vectors.
const IMAGE_COLLECTION = 'images';

type HydratedImage = Awaited<ReturnType<typeof getAllImages>>['items'][number];

const searchServiceCandidates = searchServiceSource(IMAGE_COLLECTION, {
  notFoundMessage: 'Image not found',
});

const emptyPage = () => ({ items: [], nextCursor: undefined, correctedQuery: undefined });

// With refuseNarrowing, a refused query answers no sooner than a typical search would.
// shortcut: fixed estimates; re-derive from the semantic search latency histogram if it moves.
export const OWN_REFUSAL_FLOOR_MS = 600;
export const OWN_REFUSAL_JITTER_MS = 300;
const holdOwnRefusal = (started: number) =>
  sleep(started + OWN_REFUSAL_FLOOR_MS + Math.random() * OWN_REFUSAL_JITTER_MS - Date.now());

export async function searchSemanticImages({
  input,
  user,
  domain,
  track,
  candidateSource = searchServiceCandidates,
  refuseNarrowing = false,
}: {
  input: SemanticImageSearchInput;
  // Signed out: the site defaults for hidden tags and browsing add-ons.
  user?: SessionUser;
  domain?: DomainColor;
  track?: QueryTracker;
  candidateSource?: CandidateSource;
  /** A verdict that would narrow the level refuses instead (the showcase picker's own images). */
  refuseNarrowing?: boolean;
}) {
  const started = Date.now();
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
  const audit = beginSemanticAudit({
    index: IMAGE_COLLECTION,
    viewer: user,
    query: input.query,
    firstPage: !input.cursor,
  });
  const refusalOf = makeRefusalOf({
    index: 'images_semantic',
    track,
    context: () => ({
      // With refuseNarrowing the verdict is taken at one level, whatever level is asked for.
      browsingLevel: refuseNarrowing ? allBrowsingLevelsFlag : browsingLevel,
      disablePoi: addons.disablePoi,
      isModerator: user?.isModerator,
    }),
    audit,
  });
  const refusal = input.query ? await refusalOf(input.query, 'query') : false;
  const verdictLevel = queryVerdictLevel(refusal, browsingLevel, user?.isModerator);
  const queryRefused = verdictLevel === 'refuse' || (refuseNarrowing && !!refusal);
  if (!queryRefused && verdictLevel !== browsingLevel) {
    browsingLevel = verdictLevel;
    addons = addonsFor(browsingLevel);
  }
  const excludedUserIds = viewerExcludedUserIds(hidden);
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
    filters: {
      tags?: number[];
      excludedTagIds: number[];
      fromPlatform?: boolean;
      withMeta?: boolean;
    }
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
  if (input.imageId && !queryRefused) {
    const [anchor] = await fetchVisible([input.imageId], browsingLevel, {
      excludedTagIds: viewerExcludedTagIds,
    });
    if (!anchor) throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found' });
    if (!user?.isModerator && !(await isFlipt(FLIPT_FEATURE_FLAGS.SEMANTIC_SIMILAR_ANCHOR_CAP_OFF)))
      level = anchorBrowsingLevel(browsingLevel, anchor.nsfwLevel);
  }
  const timed = <T>(stage: 'candidates' | 'hydrate', work: Promise<T>) => {
    const end = semanticSearchStage().startTimer({ index: IMAGE_COLLECTION, stage });
    return work.finally(() => end());
  };
  // Made On-site and Metadata only are judged from the image's meta, so only hydration applies them.
  const hydrate: Hydrate<HydratedImage> = (ids) =>
    timed(
      'hydrate',
      fetchVisible(ids, level, {
        tags: tagIds,
        excludedTagIds,
        fromPlatform: input.fromPlatform,
        withMeta: input.withMeta,
      })
    );
  const cachedSource = withCandidateCache(
    IMAGE_COLLECTION,
    candidateSource,
    user?.isModerator ? 'mod' : 'user'
  );

  // Hidden tags, users and images are left to hydration and `excluded` below: as Qdrant must_nots
  // they cost over a second per search on the on-disk payload, and hydration enforces them anyway.
  const filter: CandidateFilter = {
    // With refuseNarrowing, candidates are not pre-narrowed to the viewer's level.
    gate: {
      kind: 'level',
      nsfwLevels: Flags.instanceToArray(refuseNarrowing ? allBrowsingLevelsFlag : level),
    },
    tagIds,
    anyOf: { baseModels: input.baseModels, type: input.types },
    userIds,
    range: {
      key: 'sortAt',
      gte: input.postedAfter?.toISOString(),
      lte: input.postedBefore?.toISOString(),
    },
  };

  const viewer = { isModerator: !!user?.isModerator };
  // Refused before any search: the audit may run it after the response, for its row only.
  if (queryRefused) {
    if (refuseNarrowing) await holdOwnRefusal(started);
    return input.query && !input.imageId
      ? audit.refused(
          emptyPage(),
          browsingLevel,
          refusedTextCandidates(cachedSource, { text: input.query, filter, viewer })
        )
      : audit.done(emptyPage(), browsingLevel);
  }
  const query: SearchQuery = input.imageId
    ? { similarTo: input.imageId }
    : { text: input.query ?? '' };

  let correctedQuery: string | undefined;
  // Every correction is audited, not only the first: rounds of one page can come from cached blocks
  // of different ages.
  const corrections = new Map<string, ReturnType<typeof refusalOf>>();
  let correctedRefusal: QueryRefusal | undefined;
  let first: RefusedCandidates | undefined;
  const page = await collectPage({
    candidates: async (offset, limit) => {
      const result = await timed(
        'candidates',
        cachedSource({ query, filter, offset, limit, viewer, sort: input.sort })
      );
      audit.candidates(result);
      first ??= result;
      // The service embeds its spelling correction, not the text audited above.
      const corrected = result.correctedQuery;
      if (!correctedRefusal && corrected !== undefined && corrected !== input.query) {
        if (!corrections.has(corrected))
          corrections.set(corrected, refusalOf(corrected, 'correction'));
        correctedRefusal = (await corrections.get(corrected)) || undefined;
      }
      if (correctedRefusal) return [];
      correctedQuery ??= result.correctedQuery;
      return result.ids;
    },
    hydrate,
    offset: input.cursor ?? 0,
    limit: input.limit,
    excluded: new Set([...excludedImageIds, ...(input.imageId ? [input.imageId] : [])]),
  });
  if (correctedRefusal) return audit.refused(emptyPage(), level, async () => first ?? { ids: [] });
  return audit.done({ ...page, correctedQuery }, level);
}
