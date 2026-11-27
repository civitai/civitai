// A leaf (no imports): `app-access.service.ts` re-exports it, and light modules import it here.

/**
 * Postgres/Prisma "the table isn't there yet" signals.
 *
 * P2021 is Prisma's typed code; 42P01 is the raw PG SQLSTATE that surfaces through
 * `$queryRaw` and through some driver paths where Prisma has not classified the error.
 * Matching BOTH matters: a check on P2021 alone let a raw-path failure through in
 * local testing.
 *
 * 🔴 THE MESSAGE BRANCH IS DELIBERATELY NARROWER THAN "does not exist". That substring
 * also appears in `column "displayed" does not exist` and in
 * `column "x" of relation "y" does not exist` (SQLSTATE 42703) — which is EXACTLY what a
 * HALF-APPLIED manual migration produces, and this repo applies migrations by hand
 * (datapacket-talos DB rule #8). Swallowing a column error would degrade a genuinely
 * broken schema to a permanent silent "no collaborators" instead of surfacing it. So the
 * message branch requires the missing object to be named as a RELATION or TABLE, and
 * refuses anything that mentions a column at all. `app-access.service.test.ts` pins both
 * directions, including the "broadened back to `does not exist` / `not found`" mutants.
 *
 * 🔴 EXPORTED BECAUSE IT IS THE MEASURED SPELLING, AND A SECOND COPY WAS NARROWER.
 * The digital-goods rail (`isMissingGoodsTableError` in `buzz-attribution.service.ts`)
 * open-coded a code-only version of this check. On a path where Prisma leaves the
 * SQLSTATE in the MESSAGE — the very case the sentence above records as measured — that
 * copy returned false, the goods `.catch` rethrew, and `Promise.all` took BOTH owner
 * revenue pages down, including the card figures that were readable. One spelling, one
 * place: new callers delegate here rather than re-deriving the condition.
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
