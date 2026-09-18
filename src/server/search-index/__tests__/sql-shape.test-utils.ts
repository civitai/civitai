/**
 * Reading the SQL a search-index module actually issues.
 *
 * 🔴 PIN A WHOLE NORMALISED CLAUSE WITH `toBe`, NEVER A SUBSTRING. `toMatch`/`toContain` on a
 * predicate is satisfied by any statement that merely MENTIONS it, so a WIDENING mutation passes:
 * `AND (<eligibility> OR "bannedAt" IS NOT NULL)` still contains the eligibility text, and
 * `... AND id > $1 OR availability = 'Unsearchable'` still contains every fragment of the WHERE it
 * just broke — `AND` binds tighter than `OR`. Both were found by adversarial review rounds, on two
 * different index modules, against assertions that read as coverage.
 *
 * Lifted here from `user-index-eligibility.test.ts`, which found the first of those, so the second
 * caller does not have to rediscover it.
 */

/** Collapse whitespace so an assertion is about the PREDICATE, not about indentation. */
export const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/**
 * Re-compose a Prisma tagged-template call into readable SQL. Nested `Prisma.Sql` values expose
 * their own text; scalar bind params become `?`, exactly as the driver would render them.
 *
 * Scalars deliberately do NOT appear: a bind value is not part of the statement's shape. Assert
 * values separately, against the values array — see `no value is visible here` in the callers.
 */
export const renderTag = (strings: TemplateStringsArray, values: unknown[]) => {
  let out = '';
  strings.forEach((str, i) => {
    out += str;
    if (i < values.length) {
      const v = values[i] as { sql?: string };
      out += v && typeof v === 'object' && 'sql' in v ? v.sql : '?';
    }
  });
  return out;
};

/** Every WHERE clause in a statement, normalised — the part an eligibility bug lives in. */
export const whereClausesOf = (statement: string) =>
  [...norm(statement).matchAll(/\bWHERE\b\s+(.*?)(?=\s+ORDER BY\b|\s*\)\s*as\b|$)/g)].map(
    (m) => m[1]
  );
