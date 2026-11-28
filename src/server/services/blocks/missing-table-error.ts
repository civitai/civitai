// A leaf (no imports): `app-access.service.ts` re-exports it, and light modules import it here.

/**
 * Postgres/Prisma "the table isn't there yet" signals.
 *
 * P2021 (Prisma's typed code) and 42P01 (the raw PG SQLSTATE, which surfaces through
 * `$queryRaw` and driver paths Prisma has not classified) are both matched.
 *
 * The message branch accepts only a missing RELATION or TABLE and refuses any column error,
 * so a half-applied manual migration surfaces instead of being swallowed.
 * `app-access.service.test.ts` pins both directions.
 *
 * One spelling: new callers delegate here rather than re-deriving the condition.
 */
export function isMissingTableError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === 'P2021' || code === '42P01') return true;
  // Prisma wraps the driver error; the SQLSTATE is only in the message on some paths.
  const message = (err as { message?: unknown })?.message;
  if (typeof message !== 'string') return false;
  // A column/attribute error is a HALF-APPLIED migration, not an absent table.
  if (/\bcolumns?\b/i.test(message)) return false;
  return /\b42P01\b/.test(message) || /\b(?:relation|table)\s+\S+\s+does not exist/i.test(message);
}

/**
 * Is this the "column does not exist" error (a manual migration that adds a column is not applied
 * yet)? Matched on the ERROR CODE, never on the message, which is driver text that changes between
 * Prisma versions:
 *   - `P2022`: Prisma's own "The column `X` does not exist in the current database."
 *   - `42703`: Postgres `undefined_column`, on a `$queryRaw` path, and what Prisma reports in
 *     `meta.code` for some engine versions.
 *
 * 🔴 NARROW ON PURPOSE. A connection failure, a timeout, a missing TABLE (42P01) and a permission
 * error all propagate: degrading on those would turn an outage into a silently missing field.
 *
 * One spelling, as for {@link isMissingTableError}: new callers import it from here.
 */
export function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; meta?: unknown };
  if (e.code === 'P2022' || e.code === '42703') return true;
  if (e.meta && typeof e.meta === 'object') {
    const metaCode = (e.meta as { code?: unknown }).code;
    if (metaCode === '42703' || metaCode === 'P2022') return true;
  }
  return false;
}
