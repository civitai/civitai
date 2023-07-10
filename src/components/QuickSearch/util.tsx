import { isDefined } from '~/utils/type-guards';

type MatchedFilter = {
  indexName: string;
  attribute: string;
  attributeRegexp: RegExp;
  matchRegexp: RegExp;
  matches: string[] | null;
};

const applyQueryMatchers = (query: string) => {
  const filters = [
    {
      indexName: 'models',
      attribute: 'type',
      attributeRegexp: /t:(\w+)/,
      matchRegexp: /(?<=t:)\w+/,
      matches: [],
    },
  ];

  const matchedFilters: Array<MatchedFilter> = filters.map((filter) => {
    const { matchRegexp } = filter;
    return {
      ...filter,
      matches: query.match(matchRegexp),
    };
  });

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

const getMatchedFiltersByIndexName = (indexName: string, matchedFilters: Array<MatchedFilter>) => {
  return matchedFilters.filter((matchedFilter) => matchedFilter.indexName === indexName);
};

const getFiltersByIndexName = (indexName: string, matchedFilters: Array<MatchedFilter>) => {
  return getMatchedFiltersByIndexName(indexName, matchedFilters)
    .map((matchedFilter) => {
      const { attribute, matches } = matchedFilter;

      if (!matches) return '';

      return matches.map((match) => `${attribute}=${match}`).join(' AND ');
    })
    .filter(isDefined)
    .join(' AND ');
};

export { applyQueryMatchers, getMatchedFiltersByIndexName, getFiltersByIndexName };
