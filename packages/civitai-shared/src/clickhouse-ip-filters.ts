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
 * `ip != '' AND NOT isIPAddressInRange(ip, '…') AND …` — the WHERE fragment.
 *
 * 🔴 `ip != ''` IS A GUARD, NOT A TIDY-UP, AND ITS POSITION IS PART OF IT. `isIPAddressInRange`
 * RAISES on an empty string and `userActivities` holds a handful of them, so whether the query
 * throws depends on whether a blank row lands in the range being scanned — it passes in testing and
 * breaks later, once, for one reader. It is emitted first for that reason, and a caller must not
 * reorder the conjunction.
 *
 * The column is a parameter only so a reader whose column is not called `ip` can use it; it is
 * interpolated, so it must be an identifier the caller controls and never user input.
 */
export function publicIpOnlySql(column = 'ip'): string {
  return [
    `${column} != ''`,
    ...NON_PUBLIC_IP_RANGES.map((range) => `NOT isIPAddressInRange(${column}, '${range}')`),
  ].join(' AND ');
}
