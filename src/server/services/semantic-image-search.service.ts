import { TRPCError } from '@trpc/server';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { NsfwLevel } from '~/server/common/enums';
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
import type {
  RefusedCandidates,
  RefusedSearchPath,
} from '~/server/services/semantic-search-audit.service';
import { semanticSearchStage } from '~/server/metrics/semantic-search.metrics';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import { Flags } from '~/shared/utils/flags';
import { MediaType } from '~/shared/utils/prisma/enums';
import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { semanticImageHeldText } from '~/server/services/semantic-held-content.sql';
import type { DomainColor } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';
import {
  collectPage,
  resolveTagIds,
  resolveTags,
  resolveUserIds,
  searchServiceSource,
  withTagMatchesFirst,
  type CandidateFilter,
  type CandidateSource,
  type Hydrate,
  type SearchQuery,
  viewerExcludedUserIds,
} from '~/server/services/semantic-search-client';

/** The search service's collections of Image rows: stills and clips are embedded apart. */
type MediaCollection = 'images' | 'videos';

type HydratedImage = Awaited<ReturnType<typeof getAllImages>>['items'][number];

const searchServiceCandidates: Record<MediaCollection, CandidateSource> = {
  images: searchServiceSource('images', { notFoundMessage: 'Image not found' }),
  videos: searchServiceSource('videos', { notFoundMessage: 'Video not found' }),
};

/** The ids among `ids` that are held media. */
export async function heldImageIds(ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT i.id FROM "Image" i
    WHERE i.id = ANY(${ids}::int[]) AND ${Prisma.raw(semanticImageHeldText('i'))}`;
  return new Set(rows.map((r) => r.id));
}

const emptyPage = () => ({ items: [], nextCursor: undefined, correctedQuery: undefined });

export async function searchSemanticImages({
  input,
  user: sessionUser,
  asModerator = false,
  asOwner = false,
  domain,
  track,
  collection = 'images',
  candidateSource = searchServiceCandidates[collection],
  refuseNarrowing = false,
  tagMatchesFirst = false,
  uploadAnchor,
}: {
  input: SemanticImageSearchInput;
  // Signed out: the site defaults for hidden tags and browsing add-ons.
  user?: SessionUser;
  /** The request's views (`credentialViews`): without them the search reads as a plain viewer. */
  asModerator?: boolean;
  asOwner?: boolean;
  domain?: DomainColor;
  track?: QueryTracker;
  /** `videos`: the clip index; hydration then returns videos only. */
  collection?: MediaCollection;
  candidateSource?: CandidateSource;
  /** A verdict that would narrow the level refuses instead (the showcase picker's own images). */
  refuseNarrowing?: boolean;
  /** A query that names a tag ranks the images carrying it first (the showcase picker). */
  tagMatchesFirst?: boolean;
  /**
   * Search by uploaded image: the upload's scanned level and the URL to embed, from an upload that
   * passed the scan gate. Replaces `imageId` and `query`.
   */
  uploadAnchor?: { nsfwLevel: number; imageUrl: string };
}) {
  // Every moderator exemption below reads `user.isModerator`, so the viewer carries the view.
  const user = sessionUser && {
    ...sessionUser,
    isModerator: asModerator && !!sessionUser.isModerator,
  };
  let browsingLevel = resolveSemanticBrowsingLevel(
    input.browsingLevel,
    user,
    await isNonModClampOn(user)
  );
  // Video search serves the Blocked level to moderators only.
  if (collection === 'videos' && !user?.isModerator) {
    browsingLevel = Flags.removeFlag(browsingLevel, NsfwLevel.Blocked);
    if (!browsingLevel) return emptyPage();
  }

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
    index: collection,
    viewer: user,
    query: input.query,
    firstPage: !input.cursor,
  });
  const refusalOf = makeRefusalOf({
    index: `${collection}_semantic`,
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
  const refusedPath: RefusedSearchPath =
    verdictLevel === 'refuse' ? 'refused_query' : 'refused_own_images';
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
      // Users left out of these results only.
      alsoExcludedUserIds?: number[];
    }
  ) => {
    const { alsoExcludedUserIds = [], ...feedFilters } = filters;
    const { items } = await getAllImages({
      ...getInfiniteImagesSchema.parse({
        ids,
        limit: ids.length,
        sort: ImageSort.Newest,
        browsingLevel: level,
        ...feedFilters,
        ...(collection === 'videos' && { types: [MediaType.video] }),
        excludedUserIds: [...excludedUserIds, ...alsoExcludedUserIds],
        disablePoi: addons.disablePoi,
        disableMinor: addons.disableMinor,
        include: ['cosmetics', 'tagIds'],
      }),
      user,
      asModerator,
      asOwner,
      domain,
      headers: { src: 'semanticImageSearch' },
    });
    if (collection !== 'videos') return items;
    const held = await heldImageIds(items.map((i) => i.id));
    return items.filter((i) => !held.has(i.id));
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
  // An upload is embedded as a still, which is not comparable with clip vectors.
  if (uploadAnchor && collection === 'videos')
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Search by upload covers images only' });
  if (uploadAnchor) {
    // An upload is never served, so no visibility check refuses it: refuse a level the viewer
    // (already capped to the domain) may not see here.
    if (!Flags.intersects(browsingLevel, uploadAnchor.nsfwLevel))
      return audit.done(emptyPage(), browsingLevel, 'refused_upload_level');
    if (!user?.isModerator && !(await isFlipt(FLIPT_FEATURE_FLAGS.SEMANTIC_SIMILAR_ANCHOR_CAP_OFF)))
      level = anchorBrowsingLevel(browsingLevel, uploadAnchor.nsfwLevel);
  }
  const timed = <T>(stage: 'candidates' | 'hydrate', work: Promise<T>) => {
    const end = semanticSearchStage().startTimer({ index: collection, stage });
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
        // "More like this" without the viewer's own images; the source check above still sees them.
        alsoExcludedUserIds: input.excludeOwn && user ? [user.id] : undefined,
      })
    );
  // The candidate cache holds nothing per user, and an upload is one user's.
  const cachedSource = uploadAnchor
    ? candidateSource
    : withCandidateCache(collection, candidateSource, user?.isModerator ? 'mod' : 'user');

  // Hidden tags, users and images are left to hydration and `excluded` below: as Qdrant must_nots
  // they cost over a second per search on the on-disk payload, and hydration enforces them anyway.
  const filter: CandidateFilter = {
    // With refuseNarrowing, candidates are not pre-narrowed to the viewer's level.
    gate: {
      kind: 'level',
      nsfwLevels: Flags.instanceToArray(refuseNarrowing ? allBrowsingLevelsFlag : level),
    },
    tagIds,
    // Every point of the video index is a video.
    anyOf: {
      baseModels: input.baseModels,
      type: collection === 'videos' ? undefined : input.types,
    },
    userIds,
    range: {
      key: 'sortAt',
      gte: input.postedAfter?.toISOString(),
      lte: input.postedBefore?.toISOString(),
    },
  };

  const viewer = { isModerator: !!user?.isModerator };
  // Refused before any search: the audit may run it after the response, for its row only.
  if (queryRefused)
    return input.query && !input.imageId
      ? audit.refused(
          refusedPath,
          emptyPage(),
          browsingLevel,
          refusedTextCandidates(cachedSource, { text: input.query, filter, viewer })
        )
      : audit.done(emptyPage(), browsingLevel, refusedPath);
  const query: SearchQuery = uploadAnchor
    ? { imageUrl: uploadAnchor.imageUrl }
    : input.imageId
    ? { similarTo: input.imageId }
    : { text: input.query ?? '' };

  const queryTag =
    tagMatchesFirst && 'text' in query && query.text.trim()
      ? (await resolveTags([query.text.trim()])).find(
          (t) => !blockedTags.some((b) => b.id === t.id)
        )
      : undefined;
  const ranked = queryTag ? withTagMatchesFirst(cachedSource, queryTag.id) : cachedSource;

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
        ranked({ query, filter, offset, limit, viewer, sort: input.sort })
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
  if (correctedRefusal)
    return audit.refused(
      'refused_correction',
      emptyPage(),
      level,
      async () => first ?? { ids: [] }
    );
  return audit.done({ ...page, correctedQuery }, level);
}
