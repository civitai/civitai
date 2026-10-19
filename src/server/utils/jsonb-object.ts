import { Prisma } from '@prisma/client';

/**
 * `expr` when it is a JSON object, otherwise `{}`. Use it as the left side of a `||` merge.
 *
 * 🔴 `COALESCE(meta, '{}')` is NOT this. It replaces only SQL NULL, so a stored JSON `null` or an
 * array passes straight through, and `jsonb || jsonb` then CONCATENATES instead of merging:
 * `'null' || '{"a":1}'` is `[null, {"a": 1}]`, every key in it unreadable by `->`, and `jsonb_set`
 * raises on it. Four such `Model.meta` rows made prepare-leaderboard throw on 2026-10-18, and no
 * board was built for the next day. Treating a non-object as `{}` makes the next write repair the row.
 */
export function asJsonbObject(expr: string) {
  return `(CASE WHEN jsonb_typeof(${expr}) = 'object' THEN ${expr} ELSE '{}'::jsonb END)`;
}

/** {@link asJsonbObject} for a `Prisma.sql` template, where an interpolated string is bound as a value. */
export function asJsonbObjectSql(expr: string): Prisma.Sql {
  return Prisma.raw(asJsonbObject(expr));
}
