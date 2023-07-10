import { isDefined } from '~/utils/type-guards';

type FilterIndex = 'models' | 'users' | 'tags' | 'articles';
type MatchedFilter = {
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
    forceUniqueQuery: true,
    indexName: 'models',
    attribute: '',
    attributeRegexp: /^\$/,
    matchRegexp: /^\$\w+/,
    matches: [],
  },
  {
    forceUniqueQuery: true,
    indexName: 'users',
    attribute: '',
    attributeRegexp: /^@/,
    matchRegexp: /^@\w+/,
    matches: [],
  },
  {
    forceUniqueQuery: true,
    indexName: 'tags',
    attribute: '',
    attributeRegexp: /^#/,
    matchRegexp: /^#\w+/,
    matches: [],
  },
  {
    forceUniqueQuery: true,
    indexName: 'articles',
    attribute: '',
    attributeRegexp: /^&/,
    matchRegexp: /^&\w+/,
    matches: [],
  },
];

const applyQueryMatchers = (query: string) => {
  const matchedFilters: MatchedFilter[] = filters
    .map((filter) => {
      const { matchRegexp } = filter;
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

      if (!matches || !attribute) return '';

      return matches.map((match) => `${attribute}=${match}`).join(' AND ');
    })
    .filter((item) => !!item)
    .join(' AND ');
};

export {
  applyQueryMatchers,
  getMatchedFiltersByIndexName,
  getFiltersByIndexName,
  hasForceUniqueQueryAttribute,
};
