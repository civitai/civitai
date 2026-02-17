/* eslint-disable @typescript-eslint/no-explicit-any */

// OpenSearch query DSL builder — typed helpers that replace
// Meilisearch's string-based filter syntax.

export type FilterClause = Record<string, any>;

export function termFilter(field: string, value: any): FilterClause {
  return { term: { [field]: value } };
}

export function termsFilter(field: string, values: any[]): FilterClause {
  return { terms: { [field]: values } };
}

export function rangeFilter(
  field: string,
  op: 'gt' | 'gte' | 'lt' | 'lte',
  value: number
): FilterClause {
  return { range: { [field]: { [op]: value } } };
}

export function existsFilter(field: string): FilterClause {
  return { exists: { field } };
}

export function notFilter(clause: FilterClause): FilterClause {
  return { bool: { must_not: [clause] } };
}

export function orFilter(clauses: FilterClause[]): FilterClause {
  return { bool: { should: clauses, minimum_should_match: 1 } };
}

export function andFilter(clauses: FilterClause[]): FilterClause {
  return { bool: { filter: clauses } };
}

export function buildSearchBody(opts: {
  filters: FilterClause[];
  mustNot?: FilterClause[];
  sort: Array<Record<string, { order: 'asc' | 'desc' }>>;
  size: number;
  from?: number;
  searchAfter?: Array<number | string>;
}): Record<string, any> {
  const { filters, mustNot, sort, size, from, searchAfter } = opts;

  const body: Record<string, any> = {
    query: {
      bool: {
        filter: filters,
        ...(mustNot?.length ? { must_not: mustNot } : {}),
      },
    },
    sort,
    size,
  };

  if (searchAfter) {
    body.search_after = searchAfter;
  } else if (from !== undefined) {
    body.from = from;
  }

  return body;
}
