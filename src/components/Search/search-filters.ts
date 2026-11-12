import type {
  BrowsingLevelAttribute,
  BrowsingLevelMatch,
} from '~/components/Search/search-index-filters';
import {
  BROWSING_LEVEL_ATTRIBUTE,
  BROWSING_LEVEL_MATCH,
} from '~/components/Search/search-index-filters';
import type { ReverseSearchIndexKey, SearchIndexKey } from '~/components/Search/search.types';
import { reverseSearchIndexMap } from '~/components/Search/search.types';
import { NsfwLevel } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';
import { isDefined } from '~/utils/type-guards';

// Meilisearch rejects a bare `()` with invalid_search_filter, so a clause with nothing to say has
// to disappear rather than become an empty string that still gets parenthesized downstream.

// Every bit an item's level can carry, Blocked included.
const LEVEL_BITS = Object.values(NsfwLevel).filter((v): v is number => typeof v === 'number');

export function buildBrowsingLevelClause(
  attribute: BrowsingLevelAttribute | undefined,
  browsingLevel: number,
  match: BrowsingLevelMatch = 'any'
) {
  if (!attribute) return null;

  const levels = Flags.instanceToArray(browsingLevel);
  if (!levels.length) return null;

  if (match === 'subset') {
    const outside = LEVEL_BITS.filter((bit) => !(bit & browsingLevel));
    // An unrated item stays out, as before: its cover has no level to check.
    return [
      `${attribute} IS NOT EMPTY`,
      ...(outside.length ? [`${attribute} NOT IN [${outside.join(', ')}]`] : []),
    ].join(' AND ');
  }

  return levels.map((value) => `${attribute}=${value}`).join(' OR ');
}

/** The browsing-level clause for a Meilisearch index uid; `null` for an index with no level. */
export function indexBrowsingLevelClause(indexUid: string, browsingLevel: number) {
  const indexKey = reverseSearchIndexMap[indexUid as ReverseSearchIndexKey];
  return buildBrowsingLevelClause(
    indexKey ? BROWSING_LEVEL_ATTRIBUTE[indexKey] : undefined,
    browsingLevel,
    indexKey ? BROWSING_LEVEL_MATCH[indexKey] : undefined
  );
}

export function buildBrowsingLevelFilters({
  attribute,
  browsingLevel,
  match,
  filters,
}: {
  attribute: BrowsingLevelAttribute | undefined;
  browsingLevel: number;
  match?: BrowsingLevelMatch;
  filters?: string[] | string;
}) {
  const filterList = Array.isArray(filters) ? filters : [filters];

  return [...filterList, buildBrowsingLevelClause(attribute, browsingLevel, match)].filter(
    isDefined
  );
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
