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
