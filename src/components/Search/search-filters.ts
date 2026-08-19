import { Flags } from '~/shared/utils/flags';
import { isDefined } from '~/utils/type-guards';

// Meilisearch rejects a bare `()` with invalid_search_filter, so a clause with nothing to say has
// to disappear rather than become an empty string that still gets parenthesized downstream.

export function buildBrowsingLevelClause(attributeName: string, browsingLevel: number) {
  if (!attributeName) return null;

  const levels = Flags.instanceToArray(browsingLevel);
  if (!levels.length) return null;

  return levels.map((value) => `${attributeName}=${value}`).join(' OR ');
}

export function buildBrowsingLevelFilters({
  attributeName,
  browsingLevel,
  filters,
}: {
  attributeName: string;
  browsingLevel: number;
  filters?: string[] | string;
}) {
  const filterList = Array.isArray(filters) ? filters : [filters];

  return [...filterList, buildBrowsingLevelClause(attributeName, browsingLevel)].filter(isDefined);
}

export function joinFilterClauses(filters?: string[] | string) {
  const filterList = Array.isArray(filters) ? filters : filters ? [filters] : [];

  return filterList
    .filter((filter) => typeof filter === 'string' && filter.trim().length > 0)
    .map((filter) => `(${filter})`)
    .join(' AND ');
}
