import { TRPCError } from '@trpc/server';
import type { SearchParams, SearchResponse } from 'meilisearch';
import { uniq } from 'lodash-es';
import { constants, MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { isTransientMeiliError, searchClient, withMeili } from '~/server/meilisearch/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import type { GetResourceSelectInput } from '~/server/schema/model.schema';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import {
  getFeaturedModels,
  getRecentlyBid,
  getRecentlyManuallyAdded,
  getRecentlyRecommended,
  type GetFeaturedModels,
} from '~/server/services/model.service';
import { getUserBookmarkedModels } from '~/server/services/user.service';
import {
  getModelSearchIndexRecords,
  type ModelSearchIndexRecord,
} from '~/server/search-index/models.search-index';
import { transformModelHits } from '~/shared/search/models-transform';
import { and, eq, inArray, ne, not, or } from '~/shared/utils/meili-filter';
import { Availability, ModelStatus, ModelUploadType } from '~/shared/utils/prisma/enums';
import { parseAIRSafe } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

type ServiceUser = { id: number } | undefined;

const FEATURED_LIMIT = 1000;

// The own/official tabs let a creator link any of their own / the official
// component models regardless of base-model match (e.g. a VAE shared across SDXL
// variants). Mirrors the client-side skipBaseModelForOwnTabs predicate.
function skipBaseModelForOwnTabs(
  tab: GetResourceSelectInput['tab'],
  selectSource: string
): boolean {
  return (tab === 'mine' || tab === 'official') && selectSource === 'modelVersion';
}

function meiliSortFor(sort: GetResourceSelectInput['sort']): string[] | undefined {
  switch (sort) {
    case 'popularity':
      return ['metrics.thumbsUpCount:desc'];
    case 'newest':
      return ['createdAt:desc'];
    case 'relevance':
    default:
      return undefined;
  }
}

// Resolve the model-id set a tab restricts to (recent/liked/featured). Returns
// `null` when the tab imposes no id restriction (all/official/mine). An empty
// array still restricts (matches nothing) — matching the prior client behavior.
async function resolveTabIds(
  input: GetResourceSelectInput,
  user: ServiceUser
): Promise<number[] | null> {
  const { tab, selectSource } = input;
  if (tab === 'liked') return user ? await getUserBookmarkedModels({ userId: user.id }) : [];
  if (tab !== 'recent') return null;
  if (!user) return [];

  const take = 20;
  switch (selectSource) {
    case 'generation':
      return input.restrictToIds ?? [];
    case 'addResource':
      return getRecentlyManuallyAdded({ take, userId: user.id });
    case 'modelVersion':
      return getRecentlyRecommended({ take, userId: user.id });
    case 'auction':
      return getRecentlyBid({ take, userId: user.id });
    case 'training': {
      const trainingModels = await dbRead.model.findMany({
        where: {
          userId: user.id,
          uploadType: ModelUploadType.Trained,
          status: { notIn: [ModelStatus.Deleted] },
        },
        select: { modelVersions: { select: { trainingDetails: true } } },
        orderBy: { updatedAt: 'desc' },
        take,
      });
      return uniq(
        trainingModels.flatMap((m) =>
          m.modelVersions
            .map(
              (mv) =>
                parseAIRSafe((mv.trainingDetails as TrainingDetailsObj | undefined)?.baseModel)
                  ?.model
            )
            .filter(isDefined)
        )
      );
    }
    default:
      return null;
  }
}

function buildFilter({
  input,
  user,
  featuredModels,
  tabIds,
  excludeIds,
}: {
  input: GetResourceSelectInput;
  user: ServiceUser;
  featuredModels?: GetFeaturedModels;
  tabIds: number[] | null;
  // Ids pinned to the front from Postgres — excluded from the Meili stream so a
  // naturally-ranked official model isn't emitted twice across pages.
  excludeIds?: number[];
}): string | null {
  const { tab, selectSource, canGenerate, resources, filterTypes, filterBaseModels, tagName } =
    input;

  // On the featured tab, determine which types have featured models so we can
  // skip the baseModel filter for those types and instead AND an explicit id set.
  const featuredByType = new Map<string, number[]>();
  if (tab === 'featured' && featuredModels?.length) {
    for (const fm of featuredModels) {
      const ids = featuredByType.get(fm.type) ?? [];
      ids.push(fm.modelId);
      featuredByType.set(fm.type, ids);
    }
  }

  const skipBaseModel = featuredByType.size > 0 || skipBaseModelForOwnTabs(tab, selectSource);

  const typeClauses = resources.map(({ type, baseModels = [] }) => {
    const _type = filterTypes.length > 0 ? filterTypes.find((x) => x === type) : type;
    if (!_type) return null;

    const _baseModels = skipBaseModel
      ? []
      : filterBaseModels.length > 0
      ? filterBaseModels.filter((baseModel) => baseModels.includes(baseModel))
      : baseModels;

    return _baseModels.length
      ? and(eq('type', _type), inArray('versions.baseModel', _baseModels))
      : eq('type', _type);
  });

  const featuredIds =
    featuredByType.size > 0
      ? [
          ...new Set(
            featuredModels!
              .filter((fm) => resources.some((r) => r.type === fm.type))
              .map((fm) => fm.modelId)
          ),
        ]
      : [];

  return and(
    // Visibility
    selectSource === 'auction' || !user?.id
      ? ne('availability', Availability.Private)
      : or(ne('availability', Availability.Private), eq('user.id', user.id)),
    canGenerate !== undefined && eq('canGenerate', canGenerate),
    selectSource === 'auction' && not(eq('cannotPromote', true)),
    or(...typeClauses),
    featuredIds.length > 0 && inArray('id', featuredIds),
    filterTypes.length > 0 && inArray('type', filterTypes),
    filterBaseModels.length > 0 && inArray('versions.baseModel', filterBaseModels),
    tagName ? eq('tags.name', tagName) : null,
    tabIds && inArray('id', tabIds),
    tab === 'mine' && user ? eq('user.id', user.id) : null,
    tab === 'official' ? eq('user.id', constants.system.officialUserId) : null,
    excludeIds && excludeIds.length > 0 ? not(inArray('id', excludeIds)) : null,
    // Always exclude celebrity-tagged models
    not(eq('tags.name', 'celebrity'))
  );
}

async function searchModels(
  query: string,
  request: SearchParams
): Promise<SearchResponse<ModelSearchIndexRecord>> {
  if (!searchClient)
    return { hits: [], estimatedTotalHits: 0 } as unknown as SearchResponse<ModelSearchIndexRecord>;
  const client = searchClient;
  try {
    return await withMeili('search', () =>
      client.index(MODELS_SEARCH_INDEX).search<ModelSearchIndexRecord>(query, request)
    );
  } catch (err) {
    if (isTransientMeiliError(err)) {
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Model search is temporarily overloaded — please retry.',
        cause: err,
      });
    }
    throw err;
  }
}

// Small, mod-curated set — cache it like getFeaturedModels. `isOfficial` is a
// non-filterable Meili field on purpose (making it filterable forces a full-index
// reindex), so the pin is sourced from Postgres and hydrated via a Meili `id IN`.
async function getOfficialModelIds() {
  return fetchThroughCache(
    REDIS_KEYS.CACHES.OFFICIAL_MODELS,
    async () => {
      const models = await dbRead.model.findMany({
        where: { isOfficial: true, status: ModelStatus.Published },
        select: { id: true, type: true },
      });
      return models;
    },
    { ttl: 60 * 5 }
  );
}

export async function getResourceSelectModels(
  input: GetResourceSelectInput,
  { user }: { user: ServiceUser }
) {
  const { tab, query = '', sort, cursor, limit, filterTypes, filterBaseModels, tagName } = input;

  const featuredModels = tab === 'featured' ? await getFeaturedModels() : undefined;
  const tabIds = await resolveTabIds(input, user);

  // The official pin only applies to the default `all` browse: no search query and
  // no active facet filters (type/baseModel/category) — otherwise it would force
  // off-filter models to the front. When active, the matching official ids are
  // excluded from the Meili stream on EVERY page (so a naturally-ranked official
  // model isn't emitted twice) and prepended, from Postgres, on the first page.
  const officialPinActive =
    tab === 'all' &&
    !query &&
    filterTypes.length === 0 &&
    filterBaseModels.length === 0 &&
    !tagName;

  // Filtered by type only (cheap, cached). Type-matching ids that don't match the
  // ecosystem base model aren't in the Meili stream anyway, so excluding them is a
  // no-op; the actual pin below narrows to base-model matches.
  const officialIdsForType = officialPinActive
    ? (await getOfficialModelIds())
        .filter((m) => input.resources.some((r) => r.type === m.type))
        .map((m) => m.id)
    : [];

  // Featured tab loads its whole set (client re-sorts by podium position); every
  // other tab paginates via a Meili offset cursor.
  const isFeatured = tab === 'featured';
  const offset = isFeatured ? 0 : cursor ?? 0;
  const take = isFeatured ? FEATURED_LIMIT : limit;

  const filter = buildFilter({
    input,
    user,
    featuredModels,
    tabIds,
    excludeIds: officialIdsForType,
  });

  const results = await searchModels(query, {
    filter: filter ?? undefined,
    sort: meiliSortFor(sort),
    offset,
    limit: take,
  });

  let items = transformModelHits(results.hits);

  // Prepend the official models on the first page only. Sourced straight from
  // Postgres — NOT through Meili — so they always surface regardless of index
  // freshness. Kept to the requested type + base-model so an Anima checkpoint
  // picker pins the Anima model but not, say, a Krea 2 official checkpoint.
  if (officialPinActive && !cursor && officialIdsForType.length) {
    const officialItems = transformModelHits(
      await getModelSearchIndexRecords(officialIdsForType)
    ).filter((m) => {
      const baseModels = input.resources
        .filter((r) => r.type === m.type)
        .flatMap((r) => r.baseModels);
      return baseModels.length === 0 || m.versions.some((v) => baseModels.includes(v.baseModel));
    });
    // The Meili stream already excludes these ids, so no cross-page dupes.
    items = [...officialItems, ...items];
  }

  const nextCursor = !isFeatured && results.hits.length === take ? offset + take : undefined;

  return { items, nextCursor };
}
