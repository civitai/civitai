import {
  IconAmpersand,
  IconAt,
  IconCurrencyDollar,
  IconHash,
  IconSearch,
} from '@tabler/icons-react';
import React from 'react';
import { isDefined } from '~/utils/type-guards';

export type FilterIndex = 'models' | 'users' | 'tags' | 'articles';
export type FilterIdentifier = FilterIndex | 'all';
type MatchedFilter = {
  filterId?: FilterIdentifier;
  indexName: FilterIndex;
  attribute: string;
  attributeRegexp: RegExp;
  matchRegexp: RegExp;
  matches: string[] | null;
  label?: string;
  description?: string;
};

export const filterIcons: Record<FilterIdentifier, React.ReactNode> = {
  models: <IconCurrencyDollar size={18} />,
  users: <IconAt size={18} />,
  articles: <IconAmpersand size={18} />,
  tags: <IconHash size={18} />,
  all: <IconSearch size={18} />,
};

const filters: MatchedFilter[] = [
  {
    indexName: 'models',
    attribute: 'type',
    attributeRegexp: /t:(\w+)/,
    matchRegexp: /(?<=t:)\w+/,
    matches: [],
    label: 't:<type>',
    description: 'Filters by model type',
  },
  {
    indexName: 'models',
    attribute: 'nsfw',
    attributeRegexp: /s:(\w+)/,
    matchRegexp: /(?<=s:)\w+/,
    matches: [],
    label: 's:<true|false>',
    description: 'Display SFW or NSFW only',
  },
  {
    filterId: 'models',
    indexName: 'models',
    attribute: '',
    attributeRegexp: /^\$/,
    matchRegexp: /^\$/,
    matches: [],
  },
  {
    filterId: 'users',
    indexName: 'users',
    attribute: '',
    attributeRegexp: /^@/,
    matchRegexp: /^@/,
    matches: [],
  },
  {
    filterId: 'tags',
    indexName: 'tags',
    attribute: '',
    attributeRegexp: /^#/,
    matchRegexp: /^#/,
    matches: [],
  },
  {
    filterId: 'articles',
    indexName: 'articles',
    attribute: '',
    attributeRegexp: /^&/,
    matchRegexp: /^&/,
    matches: [],
  },
];

const applyQueryMatchers = (query: string, appliedFilterIds: FilterIdentifier[] = []) => {
  const matchedFilters: MatchedFilter[] = filters
    .map((filter) => {
      const { matchRegexp, filterId } = filter;

      if (filterId && appliedFilterIds.includes(filterId)) {
        return {
          ...filter,
        };
      }

      const matches = query.match(matchRegexp);

      if (!matches) {
        return null;
      }

      return {
        ...filter,
        matches: query.match(matchRegexp),
      };
    })
    .filter(isDefined);

  const updatedQuery = filters
    .reduce((acc, filter) => {
      const { attributeRegexp } = filter;
      return acc.replace(attributeRegexp, '');
    }, query)
    .trim();

  return {
    updatedQuery,
    matchedFilters,
  };
};

const getMatchedFiltersByIndexName = (indexName: string, matchedFilters: MatchedFilter[]) => {
  return matchedFilters.filter((matchedFilter) => matchedFilter.indexName === indexName);
};

const hasForceUniqueQueryAttribute = (matchedFilters: MatchedFilter[]) => {
  return matchedFilters.find((matchedFilter) => !!matchedFilter.filterId);
};

const getFiltersByIndexName = (indexName: string, matchedFilters: MatchedFilter[]) => {
  return getMatchedFiltersByIndexName(indexName, matchedFilters)
    .map((matchedFilter) => {
      const { attribute, matches } = matchedFilter;

      if (!matches || !attribute) return null;

      return matches.map((match) => `${attribute}=${match}`).join(' AND ');
    })
    .filter(isDefined)
    .join(' AND ');
};

const getAvailableFiltersByIndexName = (indexName: FilterIndex) => {
  return filters.filter((item) => item.indexName === indexName);
};

export {
  applyQueryMatchers,
  getFiltersByIndexName,
  getMatchedFiltersByIndexName,
  hasForceUniqueQueryAttribute,
  getAvailableFiltersByIndexName,
};
