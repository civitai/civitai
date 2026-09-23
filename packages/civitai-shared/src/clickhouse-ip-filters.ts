// The address space that carries no per-account signal, and the predicate that excludes it from any
// ClickHouse read of a request-level event table (`userActivities` and friends).
//
// 🔴 DECLARED ONCE BECAUSE A DIVERGENCE HERE FAILS SILENTLY IN THE WORST DIRECTION. Private and
// carrier-internal space correlates everyone and therefore no one: a query that omits this filter
// does not error, it returns a large, confident cluster made of our own infrastructure or of one
// mobile carrier's NAT, and every consumer reads that as evidence. `apps/moderator`'s reactor-lookup
// panel carried the only copy of this predicate; a second copy written by hand for a second reader is
// how one of them silently stops matching the other.
//
// Client-safe: string constants and string building only, no client, no env, no IO.

/** Our own infrastructure range. Already inside `10/8`; kept named because several moderator
 *  queries exclude it on its own without the rest of the list. */
export const INTERNAL_IP_RANGE = '10.124.0.0/16';

/**
 * Every range whose members must not be treated as a user-identifying address.
 *
 * `INTERNAL_IP_RANGE` first, then RFC1918, loopback, link-local and the IPv6 equivalents. The list is
 * over-inclusive on purpose — an address wrongly excluded costs one account's IP signal, an address
 * wrongly INCLUDED manufactures a ring out of everyone behind it.
 */
export const NON_PUBLIC_IP_RANGES: readonly string[] = [
  INTERNAL_IP_RANGE,
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  'fc00::/7',
  '::1/128',
];

/**
 * A bare ClickHouse column identifier — the only thing `publicIpOnlySql` will interpolate.
 *
 * Deliberately narrower than ClickHouse's own identifier grammar: no backtick-quoted forms, no dots,
 * no digits in the leading position. Every caller today passes a plain column name, so the narrow
 * form costs nothing, and widening it later is a decision someone makes on purpose rather than a
 * gap someone finds.
 */
const SQL_COLUMN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `ip != '' AND NOT isIPAddressInRange(ip, '…') AND …` — the WHERE fragment.
 *
 * 🔴 `ip != ''` IS A GUARD, NOT A TIDY-UP, AND ITS POSITION IS PART OF IT. `isIPAddressInRange`
 * RAISES on an empty string and `userActivities` holds a handful of them, so whether the query
 * throws depends on whether a blank row lands in the range being scanned — it passes in testing and
 * breaks later, once, for one reader. It is emitted first for that reason, and a caller must not
 * reorder the conjunction.
 *
 * The column is a parameter only so a reader whose column is not called `ip` can use it.
 *
 * 🔴 IT IS INTERPOLATED, AND A COMMENT IS NOT A PRECONDITION. This module's own sibling —
 * `apps/moderator/src/lib/server/clickhouse-filters.ts`'s `IP_PATTERN` — exists because ClickHouse
 * queries here are built by string concatenation and the client does NO escaping, so a regex at the
 * seam is this codebase's convention at exactly this point. Both call sites pass the default today,
 * which makes this unreachable and makes NOW the cheap time to close it: the guard is being added
 * before the parameter spreads, not after a caller has already reached it with something it built.
 * Throwing is the only safe direction — a shadow-mode detector that silently issues a mangled
 * statement produces a zero that reads as "no ring found".
 */
export function publicIpOnlySql(column = 'ip'): string {
  if (!SQL_COLUMN_IDENTIFIER.test(column))
    throw new Error(
      `publicIpOnlySql: column must be a bare SQL identifier, got ${JSON.stringify(column)}`
    );
  return [
    `${column} != ''`,
    ...NON_PUBLIC_IP_RANGES.map((range) => `NOT isIPAddressInRange(${column}, '${range}')`),
  ].join(' AND ');
}
