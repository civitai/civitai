import type { PGlite } from '@electric-sql/pglite';

/**
 * Runs Prisma tagged-template raw SQL (`$executeRaw`/`$queryRaw`) against an in-process PGlite, as the
 * parameterised statement Prisma would send: each interpolated value becomes `$n`. Values must be
 * plain parameters (numbers, strings, Dates, arrays); a nested `Prisma.sql` arrives as an object
 * parameter and fails loudly rather than silently.
 */
export function pgliteRaw(db: PGlite) {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) =>
    db.query(
      strings.reduce((sql, part, i) => sql + part + (i < values.length ? `$${i + 1}` : ''), ''),
      values
    );
  return {
    executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await run(strings, ...values)).affectedRows ?? 0,
    queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await run(strings, ...values)).rows,
  };
}
