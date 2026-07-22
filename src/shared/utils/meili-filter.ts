/**
 * Minimal composable builder for Meilisearch filter expressions, so callers stop
 * hand-concatenating filter strings (and hand-managing quoting/escaping/parens).
 *
 * - Strings are double-quoted and escaped; numbers/booleans are emitted raw.
 * - `and`/`or` drop falsy clauses (null | undefined | false | ''), so callers can
 *   inline conditionals: `and(base, cond && eq('x', 1))`.
 * - `and`/`or` return `null` when nothing valid remains (also droppable upstream),
 *   and skip the wrapping parens for a single clause.
 */

export type FilterValue = string | number | boolean;
export type FilterClause = string;
type MaybeClause = FilterClause | null | undefined | false;

function quote(value: FilterValue): string {
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `${value}`;
}

export const eq = (field: string, value: FilterValue): FilterClause => `${field} = ${quote(value)}`;
export const ne = (field: string, value: FilterValue): FilterClause =>
  `${field} != ${quote(value)}`;
export const inArray = (field: string, values: ReadonlyArray<FilterValue>): FilterClause =>
  `${field} IN [${values.map(quote).join(', ')}]`;
export const not = (clause: FilterClause): FilterClause => `NOT ${clause}`;

function combine(op: 'AND' | 'OR', clauses: MaybeClause[]): FilterClause | null {
  const valid = clauses.filter((c): c is FilterClause => typeof c === 'string' && c.length > 0);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];
  return `(${valid.join(` ${op} `)})`;
}

export const and = (...clauses: MaybeClause[]): FilterClause | null => combine('AND', clauses);
export const or = (...clauses: MaybeClause[]): FilterClause | null => combine('OR', clauses);
