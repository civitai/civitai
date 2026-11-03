import { UnsupportedSearchRequest } from '~/server/search/meili-filter';
import type { Clause } from '~/server/search/search-scope';

/** Maps a document attribute to the indexed field a filter on it reads; throws when not filterable. */
export type FilterFieldResolver = (attribute: string) => string;

export function fieldResolver(fields: Record<string, string>): FilterFieldResolver {
  return (attribute) => {
    const field = fields[attribute];
    if (!field) throw new UnsupportedSearchRequest(`${attribute} is not filterable`);
    return field;
  };
}

/** One clause as an OpenSearch query. Missing fields match nothing, as in Meilisearch. */
export function compileClause(clause: Clause, resolve: FilterFieldResolver): object {
  switch (clause.kind) {
    case 'eq':
      return { term: { [resolve(clause.field)]: clause.value } };
    case 'in':
      // An empty list matches nothing; `terms` with no values would, too, but say so plainly.
      return clause.values.length
        ? { terms: { [resolve(clause.field)]: clause.values } }
        : { bool: { must_not: { match_all: {} } } };
    case 'range': {
      const { gte, lte, gt, lt } = clause;
      return { range: { [resolve(clause.field)]: { gte, lte, gt, lt } } };
    }
    case 'exists':
      return { exists: { field: resolve(clause.field) } };
    case 'not':
      return { bool: { must_not: [compileClause(clause.clause, resolve)] } };
    case 'and':
      return { bool: { filter: clause.clauses.map((c) => compileClause(c, resolve)) } };
    case 'or':
      return {
        bool: {
          should: clause.clauses.map((c) => compileClause(c, resolve)),
          minimum_should_match: 1,
        },
      };
  }
}

/** Every clause must hold. */
export const compileClauses = (clauses: Clause[], resolve: FilterFieldResolver) =>
  clauses.map((clause) => compileClause(clause, resolve));
