import { isDefined } from '~/utils/type-guards';

export type FilterIndex = 'models' | 'users' | 'tags' | 'articles';
export type FilterIdentitier = 'models' | 'users' | 'tags' | 'articles' | 'all';
type MatchedFilter = {
  filterId?: FilterIdentitier;
  indexName: FilterIndex;
  attribute: string;
  attributeRegexp: RegExp;
  matchRegexp: RegExp;
  matches: string[] | null;
  forceUniqueQuery?: boolean;
};

const filters: MatchedFilter[] = [
  {
    indexName: 'models',
    attribute: 'type',
    attributeRegexp: /t:(\w+)/,
    matchRegexp: /(?<=t:)\w+/,
    matches: [],
  },
  {
    indexName: 'models',
    attribute: 'nsfw',
    attributeRegexp: /s:(\w+)/,
    matchRegexp: /(?<=s:)\w+/,
    matches: [],
  },
  {
    filterId: 'models',
    forceUniqueQuery: true,
    indexName: 'models',
    attribute: '',
    attributeRegexp: /^\$/,
    matchRegexp: /^\$/,
    matches: [],
  },
  {
    filterId: 'users',
    forceUniqueQuery: true,
    indexName: 'users',
    attribute: '',
    attributeRegexp: /^@/,
    matchRegexp: /^@/,
    matches: [],
  },
  {
    filterId: 'tags',
    forceUniqueQuery: true,
    indexName: 'tags',
    attribute: '',
    attributeRegexp: /^#/,
    matchRegexp: /^#/,
    matches: [],
  },
  {
    filterId: 'articles',
    forceUniqueQuery: true,
    indexName: 'articles',
    attribute: '',
    attributeRegexp: /^&/,
    matchRegexp: /^&/,
    matches: [],
  },
];

const applyQueryMatchers = (query: string, appliedFilterIds: FilterIdentitier[] = []) => {
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
  return matchedFilters.find((matchedFilter) => matchedFilter.forceUniqueQuery);
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

export {
  applyQueryMatchers,
  getMatchedFiltersByIndexName,
  getFiltersByIndexName,
  hasForceUniqueQueryAttribute,
};
