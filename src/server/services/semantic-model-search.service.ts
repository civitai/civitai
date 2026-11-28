import type { modelFeedQueryOptions } from '~/server/controllers/model.controller';
import { ModelSort } from '~/server/common/enums';
import { semanticSearchStage } from '~/server/metrics/semantic-search.metrics';
import type { SemanticModelSearchInput } from '~/server/schema/semantic-model-search.schema';
import { getModelsWithImagesAndModelVersions } from '~/server/services/model.service';
import { withCandidateCache } from '~/server/services/semantic-candidate-cache';
import {
  beginSemanticAudit,
  isNonModClampOn,
  queryVerdictLevel,
  recordRefusal,
  refusedTextCandidates,
  resolveSemanticBrowsingLevel,
  semanticQueryRefusal,
  type QueryStage,
  type QueryTracker,
} from '~/server/services/semantic-query-guard';
import {
  auditedTextCandidates,
  collectPage,
  MAX_CANDIDATE_LIMIT,
  resolveUserIds,
  searchServiceSource,
  viewerExcludedUserIds,
  withWordMatchesFirst,
  type CandidateFilter,
  type CandidateSource,
  type Hydrate,
} from '~/server/services/semantic-search-client';
import { getBrowsingSettingAddons } from '~/server/services/system-cache';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';

const MODEL_COLLECTION = 'models';

type FeedQueryOptions = Awaited<ReturnType<typeof modelFeedQueryOptions>>;
type HydratedModel = Awaited<
  ReturnType<typeof getModelsWithImagesAndModelVersions>
>['items'][number];

const searchServiceCandidates = searchServiceSource(MODEL_COLLECTION);

// Published dates are whole UTC days, both inclusive.
const dayStart = (day?: string) => (day ? `${day}T00:00:00.000Z` : undefined);
const dayEnd = (day?: string) => (day ? `${day}T23:59:59.999Z` : undefined);

export async function searchSemanticModels({
  input,
  user,
  queryOptions,
  track,
  onViewerDependent,
  candidateSource = searchServiceCandidates,
}: {
  input: SemanticModelSearchInput;
  user?: SessionUser;
  /** The models feed's own read options (`modelFeedQueryOptions`), so hydration is the feed's query. */
  queryOptions: FeedQueryOptions;
  track?: QueryTracker;
  /** Called when the rows shown depend on who asked, so the response must not be cached for others. */
  onViewerDependent?: () => void;
  candidateSource?: CandidateSource;
}) {
  const none = {
    items: [] as HydratedModel[],
    nextCursor: undefined,
    correctedQuery: undefined,
    refused: false as boolean,
  };
  const { query, cursor, limit, spellcheck, searchSort, ...feedFilters } = input;
  let browsingLevel = resolveSemanticBrowsingLevel(
    input.browsingLevel,
    user,
    await isNonModClampOn(user)
  );
  const [hidden, addonData, userIds] = await Promise.all([
    getAllHiddenForUser({ userId: user?.id }),
    getBrowsingSettingAddons(),
    input.username ? resolveUserIds([input.username]) : undefined,
  ]);
  if (userIds && !userIds.length) return none;

  const addonsFor = (level: number) =>
    resolveBrowsingSettingsAddons(addonData, level, { isModerator: user?.isModerator });
  let addons = addonsFor(browsingLevel);
  const audit = beginSemanticAudit({
    index: MODEL_COLLECTION,
    viewer: user,
    query,
    firstPage: !cursor,
  });
  const refusalOf = async (text: string, stage: QueryStage) => {
    const refusal = await semanticQueryRefusal(text, {
      browsingLevel,
      disablePoi: addons.disablePoi,
      isModerator: user?.isModerator,
    });
    recordRefusal(track, refusal, text, 'models_semantic', stage);
    audit.verdict(refusal);
    return refusal;
  };
  const verdictLevel = queryVerdictLevel(
    await refusalOf(query, 'query'),
    browsingLevel,
    user?.isModerator
  );
  const queryRefused = verdictLevel === 'refuse';
  if (!queryRefused && verdictLevel !== browsingLevel) {
    browsingLevel = verdictLevel;
    addons = addonsFor(browsingLevel);
  }

  // The index carries no tags, so hidden tags are left to the feed's client-side preferences.
  const filter: CandidateFilter = {
    gate: { kind: 'level', nsfwLevels: Flags.instanceToArray(browsingLevel) },
    anyOf: {
      type: input.types,
      checkpointType: input.checkpointType ? [input.checkpointType] : undefined,
      baseModels: input.baseModels,
    },
    userIds,
    range: {
      key: 'publishedAt',
      gte: dayStart(input.publishedFrom),
      lte: dayEnd(input.publishedTo),
    },
  };
  const viewer = { isModerator: !!user?.isModerator };
  const cachedSource = withCandidateCache(
    MODEL_COLLECTION,
    candidateSource,
    user?.isModerator ? 'mod' : 'user'
  );
  // Refused before any search: the audit may run it after the response, for its row only.
  if (queryRefused)
    return audit.refused(
      'refused_query',
      none,
      browsingLevel,
      refusedTextCandidates(cachedSource, { text: query, filter, viewer })
    );

  const timed = <T>(stage: 'candidates' | 'hydrate', work: Promise<T>) => {
    const end = semanticSearchStage().startTimer({ index: MODEL_COLLECTION, stage });
    return work.finally(() => end());
  };
  // The index only proposes. The feed's own query, narrowed to the candidates, decides what is
  // shown, so every feed filter, the private-model rule and moderation apply as they do on the feed.
  // No `query`: it would run Meilisearch.
  const feedInput = (ids: number[]) => ({
    ...feedFilters,
    browsingLevel,
    excludedUserIds: [
      ...new Set([...(input.excludedUserIds ?? []), ...viewerExcludedUserIds(hidden)]),
    ],
    disablePoi: addons.disablePoi || input.disablePoi,
    disableMinor: addons.disableMinor || input.disableMinor,
    limit: ids.length,
  });
  const feed = async (args: Parameters<typeof getModelsWithImagesAndModelVersions>[0]) => {
    const result = await timed('hydrate', getModelsWithImagesAndModelVersions(args));
    if (result.isPrivate) onViewerDependent?.();
    return result;
  };
  // Best match: Newest is the cheapest order, and collectPage keeps rank order.
  const hydrate: Hydrate<HydratedModel> = async (ids) =>
    (
      await feed({
        ...queryOptions,
        input: { ...feedInput(ids), sort: ModelSort.Newest },
        onlyModelIds: ids,
      })
    ).items;

  // Name or tag matches first (the `name` word index, the `tags` keyword index), then by meaning.
  const ranked = withWordMatchesFirst(cachedSource, 'name', 'tags');
  const search = auditedTextCandidates({
    source: (args) => timed('candidates', ranked(args)),
    viewer,
    text: query,
    spellcheck,
    filter,
    audit: (correction) => refusalOf(correction, 'correction'),
  });
  // The Hidden view lists exactly these.
  const excluded = input.hidden
    ? undefined
    : new Set(hidden.hiddenModels.filter((x) => x.hidden).map((x) => x.id));

  const page = searchSort
    ? await (async () => {
        const pool = await topCandidates(search.candidates, excluded);
        if (!pool.length) return { items: [], nextCursor: undefined };
        const { items, nextCursor } = await feed({
          ...queryOptions,
          input: { ...feedInput(pool), sort: searchSort, cursor, limit },
          onlyModelIds: pool,
        });
        return { items, nextCursor };
      })()
    : await collectPage({
        candidates: search.candidates,
        hydrate,
        // A keyset cursor from a sorted page means nothing here: start over.
        offset: typeof cursor === 'number' ? cursor : 0,
        limit,
        excluded,
      });

  audit.candidates(search.state.first);
  if (search.state.refused)
    return audit.refused(
      'refused_correction',
      none,
      browsingLevel,
      async () => search.state.first ?? { ids: [] }
    );
  return audit.done({ ...page, correctedQuery: search.state.correctedQuery }, browsingLevel);
}

/**
 * How many of the best matches a sort reorders. A sort over the whole ranking would surface
 * barely related models with high counts; the feed query orders, filters and pages this pool.
 */
const SORT_POOL = 500;

/** The first SORT_POOL candidates, less the excluded. */
async function topCandidates(
  candidates: (offset: number, limit: number) => Promise<number[]>,
  excluded: Set<number> | undefined
) {
  const pool = new Set<number>();
  for (let offset = 0; offset < SORT_POOL; ) {
    const size = Math.min(MAX_CANDIDATE_LIMIT, SORT_POOL - offset);
    const ids = await candidates(offset, size);
    for (const id of ids) if (!excluded?.has(id)) pool.add(id);
    offset += ids.length;
    // A short block is the end of the ranking.
    if (ids.length < size) break;
  }
  return [...pool];
}
