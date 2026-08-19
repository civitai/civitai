import { quoteMeiliValue } from '~/components/Search/meili-filter';
import { QS } from '~/utils/qs';
import { getModelUrl } from '~/utils/string-helpers';

const queryFilters: Record<
  string,
  { AIR?: RegExp; filters: Record<string, RegExp>; searchPageMap: Record<string, string> }
> = {
  models: {
    AIR: /^civitai:(?<modelId>\d+)@(?<modelVersionId>\d+)/g,
    filters: {
      'tags.name': /(^|\s+)(?<not>!|-)?#(?<value>\w+)/g,
      'user.username': /(^|\s+)(?<not>!|-)?@(?<value>\w+)/g,
      'versions.hashes': /(^|\s+)(?<not>!|-)?hash:(?<value>[A-Za-z0-9_.-]+)/g,
    },
    searchPageMap: {
      'user.username': 'users',
      'tags.name': 'tags',
    },
  },
};

export function checkAIR(index: string, query: string) {
  const filterAttributes = queryFilters[index] ?? {};

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

export function parseQuery(index: string, query: string) {
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

export function buildSearchPageUrl(index: string, search: string) {
  const { query, searchPageQuery } = parseQuery(index, search);

  const queryString = QS.stringify({
    query: query.trim(),
    ...QS.parse(searchPageQuery),
  });

  return `/search/${index}?${queryString}`;
}
