import type { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';

/**
 * Runs Prisma tagged-template raw SQL (`$executeRaw`/`$queryRaw`) against an in-process PGlite, as the
 * parameterised statement Prisma would send: each interpolated value becomes `$n`, and a nested
 * `Prisma.sql` fragment is inlined with its own values, as Prisma does.
 */
export function pgliteRaw(db: PGlite) {
  // Prisma also takes a built `Prisma.Sql` as the only argument.
  const run = (strings: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    const sql = Array.isArray(strings)
      ? Prisma.sql(strings as TemplateStringsArray, ...values)
      : (strings as Prisma.Sql);
    return db.query(sql.text, sql.values);
  };
  return {
    executeRaw: async (strings: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      (await run(strings, ...values)).affectedRows ?? 0,
    queryRaw: async (strings: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      (await run(strings, ...values)).rows,
  };
}
