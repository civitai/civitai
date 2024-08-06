import { Expression, Simplify, sql } from 'kysely';

export function jsonArrayFrom<O>(expr: Expression<O>) {
  return sql<Simplify<O>[]>`(select coalesce(json_agg(agg), '[]') from ${expr} as agg)`;
}

export function jsonObjectFrom<O>(expr: Expression<O>) {
  return sql<Simplify<O> | null>`(select to_json(obj) from ${expr} as obj)`;
}
