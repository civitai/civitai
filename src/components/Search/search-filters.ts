import type { BrowsingLevelAttribute } from '~/components/Search/search-index-filters';
import type { SearchIndexKey } from '~/components/Search/search.types';
import { Flags } from '~/shared/utils/flags';
import { isDefined } from '~/utils/type-guards';

// Meilisearch rejects a bare `()` with invalid_search_filter, so a clause with nothing to say has
// to disappear rather than become an empty string that still gets parenthesized downstream.

export function buildBrowsingLevelClause(
  attribute: BrowsingLevelAttribute | undefined,
  browsingLevel: number
) {
  if (!attribute) return null;

  const levels = Flags.instanceToArray(browsingLevel);
  if (!levels.length) return null;

  return levels.map((value) => `${attribute}=${value}`).join(' OR ');
}

export function buildBrowsingLevelFilters({
  attribute,
  browsingLevel,
  filters,
}: {
  attribute: BrowsingLevelAttribute | undefined;
  browsingLevel: number;
  filters?: string[] | string;
}) {
  const filterList = Array.isArray(filters) ? filters : [filters];

  return [...filterList, buildBrowsingLevelClause(attribute, browsingLevel)].filter(isDefined);
}

export function joinFilterClauses(filters?: string[] | string) {
  const filterList = Array.isArray(filters) ? filters : filters ? [filters] : [];

  return filterList
    .filter((filter) => typeof filter === 'string' && filter.trim().length > 0)
    .map((filter) => `(${filter})`)
    .join(' AND ');
}

const MINOR_FILTERABLE_INDEXES: SearchIndexKey[] = ['models', 'images'];

export function buildMinorExclusionFilter({
  targetIndex,
  addons,
  currentUser,
}: {
  targetIndex: SearchIndexKey;
  addons: { disableMinor?: boolean };
  currentUser?: { id?: number } | null;
}) {
  if (!MINOR_FILTERABLE_INDEXES.includes(targetIndex) || !addons.disableMinor) return null;
  // The owner is matched by id only. The images index can only match a username, which a rename
  // or a reused name can point at another account, so images exempt no one.
  return targetIndex === 'models' && currentUser?.id
    ? `minor != true OR user.id = ${currentUser.id}`
    : 'minor != true';
}
