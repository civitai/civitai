import type { SearchIndex, SearchQuery, SearchQueryFor } from '~/server/schema/search.schema';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { Availability } from '~/shared/utils/prisma/enums';

// Engine-neutral filter clauses. Every search engine adapter compiles these; nothing upstream of
// an adapter ever builds a filter string.

export type Clause =
  | { kind: 'eq'; field: string; value: string | number | boolean }
  /** Matches when the field (or any element of an array field) is one of `values`. Empty matches nothing. */
  | { kind: 'in'; field: string; values: (string | number)[] }
  | { kind: 'range'; field: string; gte?: number; lte?: number; gt?: number; lt?: number }
  /** Matches when the field holds any value. */
  | { kind: 'exists'; field: string }
  | { kind: 'not'; clause: Clause }
  | { kind: 'and'; clauses: Clause[] }
  | { kind: 'or'; clauses: Clause[] };

export type SearchViewer = {
  userId?: number | null;
  isModerator?: boolean | null;
  /** The most this request may be served; `undefined` where the site caps nothing. */
  browsingLevelCap?: number;
};

const BROWSING_LEVEL_FIELD: Partial<Record<SearchIndex, string>> = {
  models: 'nsfwLevel',
  articles: 'nsfwLevel',
  collections: 'nsfwLevel',
  bounties: 'nsfwLevel',
  comics: 'nsfwLevel',
};

/**
 * The browsing level a request is served at: the viewer's choice narrowed to the site's cap. With
 * no choice it is the public level. It can come out 0 (a choice wholly above the cap), which
 * matches nothing rather than falling back to anything wider.
 */
export function effectiveBrowsingLevel(requested: number | undefined, cap: number | undefined) {
  const level = requested ?? publicBrowsingLevelsFlag;
  return cap === undefined ? level : Flags.intersection(level, cap);
}

/** The clauses `viewer` is held to on `index`, whatever the query asked for. */
export function viewerScope(
  index: SearchIndex,
  viewer: SearchViewer,
  requestedBrowsingLevel?: number
): Clause[] {
  const clauses: Clause[] = [];

  if (index === 'models' && !viewer.isModerator) {
    const userId = Number(viewer.userId);
    const ownModel: Clause | undefined =
      Number.isInteger(userId) && userId > 0
        ? { kind: 'eq', field: 'user.id', value: userId }
        : undefined;
    const unlessOwn = (clause: Clause): Clause =>
      ownModel ? { kind: 'or', clauses: [clause, ownModel] } : clause;

    clauses.push(
      unlessOwn({ kind: 'not', clause: { kind: 'eq', field: 'poi', value: true } }),
      unlessOwn({
        kind: 'not',
        clause: { kind: 'eq', field: 'availability', value: Availability.Private },
      })
    );
  }

  const field = BROWSING_LEVEL_FIELD[index];
  if (field) {
    const level = effectiveBrowsingLevel(requestedBrowsingLevel, viewer.browsingLevelCap);
    clauses.push({ kind: 'in', field, values: Flags.instanceToArray(level) });
  }

  return clauses;
}

const anyOf = (field: string, values: (string | number)[] | undefined): Clause[] =>
  values?.length ? [{ kind: 'in', field, values }] : [];
const noneOf = (field: string, values: (string | number)[] | undefined): Clause[] =>
  values?.length ? [{ kind: 'not', clause: { kind: 'in', field, values } }] : [];

/** The clauses for what the query itself asked to narrow by. */
export function queryClauses(query: SearchQuery): Clause[] {
  switch (query.index) {
    case 'models': {
      const f = query.filters;
      return [
        ...anyOf('type', f.types),
        ...anyOf('versions.baseModel', f.baseModels),
        ...anyOf('category.name', f.categories),
        ...anyOf('checkpointType', f.checkpointTypes),
        ...anyOf('tags.name', f.tags),
        ...noneOf('tags.name', f.excludeTags),
        ...anyOf('user.username', f.usernames),
        ...noneOf('user.username', f.excludeUsernames),
        ...anyOf(
          'versions.hashes',
          f.hashes?.map((hash) => hash.toLowerCase())
        ),
        ...(f.lastVersionAt &&
        (f.lastVersionAt.from !== undefined || f.lastVersionAt.to !== undefined)
          ? [
              {
                kind: 'range',
                field: 'lastVersionAtUnix',
                gte: f.lastVersionAt.from,
                lte: f.lastVersionAt.to,
              } satisfies Clause,
            ]
          : []),
      ];
    }
    case 'articles': {
      const f = query.filters;
      return [
        ...anyOf('tags.name', f.tags),
        ...noneOf('tags.name', f.excludeTags),
        ...anyOf('user.username', f.usernames),
        ...noneOf('user.username', f.excludeUsernames),
      ];
    }
    case 'users':
      return [];
    case 'collections': {
      const f = query.filters;
      return [
        ...anyOf('type', f.types),
        ...anyOf('user.username', f.usernames),
        ...noneOf('user.username', f.excludeUsernames),
      ];
    }
    case 'bounties': {
      const f = query.filters;
      return [
        ...anyOf('type', f.types),
        ...anyOf('details.baseModel', f.baseModels),
        ...anyOf('tags.name', f.tags),
        ...noneOf('tags.name', f.excludeTags),
        ...anyOf('user.username', f.usernames),
        ...noneOf('user.username', f.excludeUsernames),
      ];
    }
    case 'tools':
      return [...anyOf('type', query.filters.types), ...anyOf('company', query.filters.companies)];
    case 'comics':
      return anyOf('genre', query.filters.genres);
  }
}

/** Everything a search is filtered by: the query's own narrowing AND the viewer's scope. */
export function searchClauses(query: SearchQuery, viewer: SearchViewer): Clause[] {
  return [...queryClauses(query), ...viewerScope(query.index, viewer, query.browsingLevel)];
}

export type SortSpec = { field: string; order: 'asc' | 'desc' } | null;

/** `null` = the engine's relevance order. */
export const SORT_FIELDS: {
  [I in SearchIndex]: Record<SearchQueryFor<I>['sort'], SortSpec>;
} = {
  models: {
    relevance: null,
    mostLiked: { field: 'metrics.thumbsUpCount', order: 'desc' },
    mostDownloaded: { field: 'metrics.downloadCount', order: 'desc' },
    mostFavorited: { field: 'metrics.favoriteCount', order: 'desc' },
    mostDiscussed: { field: 'metrics.commentCount', order: 'desc' },
    mostCollected: { field: 'metrics.collectedCount', order: 'desc' },
    mostTipped: { field: 'metrics.tippedAmountCount', order: 'desc' },
    newest: { field: 'createdAt', order: 'desc' },
  },
  articles: {
    relevance: null,
    mostFavorited: { field: 'stats.favoriteCount', order: 'desc' },
    mostViewed: { field: 'stats.viewCount', order: 'desc' },
    mostDiscussed: { field: 'stats.commentCount', order: 'desc' },
    mostTipped: { field: 'stats.tippedAmountCount', order: 'desc' },
    newest: { field: 'createdAt', order: 'desc' },
  },
  users: {
    relevance: null,
    mostFollowed: { field: 'metrics.followerCount', order: 'desc' },
    mostLiked: { field: 'metrics.thumbsUpCount', order: 'desc' },
    mostUploads: { field: 'metrics.uploadCount', order: 'desc' },
    newest: { field: 'createdAt', order: 'desc' },
  },
  collections: {
    relevance: null,
    mostFollowed: { field: 'metrics.followerCount', order: 'desc' },
    mostItems: { field: 'metrics.itemCount', order: 'desc' },
    newest: { field: 'createdAt', order: 'desc' },
  },
  bounties: {
    relevance: null,
    highestBounty: { field: 'stats.unitAmountCountAllTime', order: 'desc' },
    mostEntries: { field: 'stats.entryCountAllTime', order: 'desc' },
    mostFavorited: { field: 'stats.favoriteCountAllTime', order: 'desc' },
    newest: { field: 'createdAt', order: 'desc' },
  },
  tools: {
    relevance: null,
    nameAsc: { field: 'name', order: 'asc' },
    nameDesc: { field: 'name', order: 'desc' },
    oldest: { field: 'createdAt', order: 'asc' },
    newest: { field: 'createdAt', order: 'desc' },
  },
  comics: {
    relevance: null,
    newest: { field: 'createdAt', order: 'desc' },
    oldest: { field: 'createdAt', order: 'asc' },
    mostFollowed: { field: 'stats.followerCount', order: 'desc' },
    mostChapters: { field: 'stats.chapterCount', order: 'desc' },
  },
};

/**
 * Today's search URLs carry sort as a Meilisearch virtual index name (`models_v9:metrics.downloadCount:desc`),
 * and those URLs live in bookmarks and search engines. Maps one to the new sort for its index, or
 * `undefined` when it names no sort we serve. The version suffix is ignored so an older index
 * name in an old URL still maps.
 */
export function sortFromLegacySortBy(
  index: SearchIndex,
  sortBy: string
): SearchQuery['sort'] | undefined {
  const [indexName, field, order] = sortBy.split(':');
  if (!indexName || indexName.replace(/_v\d+$/, '') !== legacyIndexPrefix[index]) return undefined;
  if (!field) return 'relevance';
  // The old bounties "newest" option carried no direction and so sorted oldest first; it was
  // labelled Newest, so it maps to what the label promised.
  const wanted = order ?? (index === 'bounties' && field === 'createdAt' ? 'desc' : 'asc');
  const sorts = SORT_FIELDS[index] as Record<string, SortSpec>;
  return Object.keys(sorts).find(
    (sort) => sorts[sort]?.field === field && sorts[sort]?.order === wanted
  ) as SearchQuery['sort'] | undefined;
}

const legacyIndexPrefix: Record<SearchIndex, string> = {
  models: 'models',
  articles: 'articles',
  users: 'users',
  collections: 'collections',
  bounties: 'bounties',
  tools: 'tools',
  comics: 'comics',
};
