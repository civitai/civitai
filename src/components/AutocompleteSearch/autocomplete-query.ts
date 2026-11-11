import { quoteMeiliValue } from '~/components/Search/meili-filter';
import type { SearchIndexKey } from '~/components/Search/search.types';
import { QS } from '~/utils/qs';
import { getModelUrl } from '~/utils/string-helpers';

const TAG_TOKEN = /(^|\s+)(?<not>!|-)?#(?<value>\w+)/g;
const USER_TOKEN = /(^|\s+)(?<not>!|-)?@(?<value>\w+)/g;
const HASH_TOKEN = /(^|\s+)(?<not>!|-)?hash:(?<value>[A-Za-z0-9_.-]+)/g;

// Each key is an attribute its index declares filterable, and they diverge — images stores tags as
// `tagNames`. One the index doesn't declare makes Meilisearch reject the search with a 400, which
// the client swallows into an empty dropdown; search-index-contract.test.ts holds these against the
// index definitions.
export const queryFilters: Partial<
  Record<
    SearchIndexKey,
    { AIR?: RegExp; filters: Record<string, RegExp>; searchPageMap: Record<string, string> }
  >
> = {
  models: {
    AIR: /^civitai:(?<modelId>\d+)@(?<modelVersionId>\d+)/g,
    filters: {
      'tags.name': TAG_TOKEN,
      'user.username': USER_TOKEN,
      'versions.hashes': HASH_TOKEN,
    },
    searchPageMap: {
      'tags.name': 'tags',
      'user.username': 'users',
    },
  },
  images: {
    filters: {
      tagNames: TAG_TOKEN,
      'user.username': USER_TOKEN,
    },
    searchPageMap: {
      tagNames: 'tags',
      'user.username': 'users',
    },
  },
  articles: {
    filters: {
      'tags.name': TAG_TOKEN,
      'user.username': USER_TOKEN,
    },
    searchPageMap: {
      'tags.name': 'tags',
      'user.username': 'users',
    },
  },
  collections: {
    filters: {
      'user.username': USER_TOKEN,
    },
    searchPageMap: {
      'user.username': 'users',
    },
  },
};

export function checkAIR(index: SearchIndexKey, query: string) {
  const filterAttributes = queryFilters[index];

  if (!filterAttributes?.AIR) {
    return null;
  }

  const { AIR } = filterAttributes;
  const [match] = query.matchAll(AIR);

  if (!match) return null;

  if (index === 'models') {
    const modelId = match?.groups?.modelId;
    const modelVersionId = match?.groups?.modelVersionId;

    if (!modelId || !modelVersionId) return null;

    return getModelUrl({ modelId: Number(modelId), modelVersionId: Number(modelVersionId) });
  }

  return null;
}

export function parseQuery(index: SearchIndexKey, query: string) {
  const filterAttributes = queryFilters[index];
  const filters = [];
  const searchPageQuery = [];

  if (filterAttributes) {
    for (const [attribute, regex] of Object.entries(filterAttributes.filters)) {
      for (const match of query.matchAll(regex)) {
        const cleanedMatch = match?.groups?.value?.trim();
        const not = match?.groups?.not !== undefined;
        if (!cleanedMatch) continue;
        filters.push(`${not ? 'NOT ' : ''}${attribute} = ${quoteMeiliValue(cleanedMatch)}`);
        searchPageQuery.push(
          `${filterAttributes.searchPageMap[attribute] ?? attribute}=${encodeURIComponent(
            cleanedMatch ?? ''
          )}`
        );
      }

      query = query.replace(regex, '');
      if (query.length === 0 && filters.length !== 0) query = ' ';
    }
  }

  return { query, filters: filters.join(' AND '), searchPageQuery: searchPageQuery.join('&') };
}

export function buildSearchPageUrl(index: SearchIndexKey, search: string) {
  const { query, searchPageQuery } = parseQuery(index, search);

  const queryString = QS.stringify({
    query: query.trim(),
    ...QS.parse(searchPageQuery),
  });

  return queryString ? `/search/${index}?${queryString}` : `/search/${index}`;
}

/**
 * Search v3: what a header search applies to the images feed. `@user` becomes the feed's user
 * filter; `#tag` words stay in the query, which the search matches by meaning.
 */
export function parseFeedSearch(search: string) {
  const username = [...search.matchAll(USER_TOKEN)].find((match) => !match.groups?.not)?.groups
    ?.value;
  const query = search
    .replace(USER_TOKEN, ' ')
    .replace(TAG_TOKEN, (...args) => {
      const groups = args.at(-1) as { not?: string; value: string };
      return groups.not ? ' ' : ` ${groups.value}`;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { query: query || undefined, username };
}

/**
 * The feed a header search lands on, for an index whose feed answers `?query=` (images so far);
 * null for the rest, which still open their search page.
 */
export function buildFeedSearchUrl(index: SearchIndexKey, search: string) {
  if (index !== 'images') return null;
  const queryString = QS.stringify(parseFeedSearch(search));
  return queryString ? `/images?${queryString}` : '/images';
}
