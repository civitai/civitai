import {
  IconAmpersand,
  IconAt,
  IconCurrencyDollar,
  IconHash,
  IconSearch,
  TablerIconsProps,
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
  matches: string[] | null;
  label?: string;
  description?: string;
};

export function FilterIcon({ type, ...props }: TablerIconsProps & { type: FilterIdentifier }) {
  return {
    models: <IconCurrencyDollar {...props} />,
    users: <IconAt {...props} />,
    articles: <IconAmpersand {...props} />,
    tags: <IconHash {...props} />,
    all: <IconSearch {...props} />,
  }[type];
}

const filters: MatchedFilter[] = [
  {
    indexName: 'models',
    attribute: 'type',
    attributeRegexp: /t:(\w+)/g,
    matches: [],
    label: 't:<type>',
    description: 'Filters by model type',
  },
  {
    indexName: 'models',
    attribute: 'nsfw',
    attributeRegexp: /nsfw:(\w+)/,
    matches: [],
    label: 'nsfw:<true|false>',
    description: 'Display SFW or NSFW only',
  },
  {
    filterId: 'models',
    indexName: 'models',
    attribute: '',
    attributeRegexp: /^(\$)/,
    matches: [],
  },
  {
    filterId: 'users',
    indexName: 'users',
    attribute: '',
    attributeRegexp: /^(@)/,
    matches: [],
  },
  {
    filterId: 'tags',
    indexName: 'tags',
    attribute: '',
    attributeRegexp: /^(#)/,
    matches: [],
  },
  {
    filterId: 'articles',
    indexName: 'articles',
    attribute: '',
    attributeRegexp: /^(&)/,
    matches: [],
  },
];

const applyQueryMatchers = (query: string, appliedFilterIds: FilterIdentifier[] = []) => {
  const matchedFilters: MatchedFilter[] = filters
    .map((filter) => {
      const { attributeRegexp, filterId, attribute } = filter;

      if (filterId && appliedFilterIds.includes(filterId)) {
        return {
          ...filter,
        };
      }

      const matches: string[] = [];
      if (!query && attribute === 'nsfw') {
        matches.push('false');
      } else if (attributeRegexp.global) {
        for (const [, group] of query.matchAll(attributeRegexp)) {
          matches.push(group);
        }
      } else {
        const [, group] = query.match(attributeRegexp) ?? [];
        if (group) matches.push(group);
      }

      if (!matches.length) return null;

      return {
        ...filter,
        matches,
      };
    })
    .filter(isDefined);

  const updatedQuery = filters
    .reduce((acc, filter) => {
      const { attributeRegexp } = filter;
      if (attributeRegexp.global) return acc.replaceAll(attributeRegexp, '');
      else return acc.replace(attributeRegexp, '');
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

      return matches.map((match) => `${attribute}=${match}`).join(' OR ');
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
