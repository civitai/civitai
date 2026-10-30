/**
 * The visible slice of a blocklist, filtered then capped.
 *
 * 🔴 Order matters: `EmailDomain` is 8295 entries in production, so the cap exists to keep the
 * page renderable — but capping BEFORE the filter would search only the first `limit` entries
 * alphabetically, and a moderator searching for anything past that would be told it is not on
 * the list. The cap bounds what is drawn, never what is searched.
 *
 * 🔴 The match is BIDIRECTIONAL because the lists do not all enforce in the same direction.
 * `UsernamePartial` enforces `username.includes(entry)` (`user.service.ts`) and `MessagePattern`
 * enforces `value.includes(pattern)` (`blocklist.service.ts`), so a moderator pasting the
 * username they were asked about — `xXscammerXx` — must be shown the entry `scammer` that
 * blocks it. A one-directional `entry.includes(needle)` answers "No entry contains that", which
 * is true and reads as "not on the list".
 */
export function visibleBlocklistItems(items: string[], filter: string, limit: number) {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return { matches: items, visible: items.slice(0, limit) };

  const matches = items.filter((item) => {
    const lower = item.toLowerCase();
    return lower.includes(needle) || needle.includes(lower);
  });
  return { matches, visible: matches.slice(0, limit) };
}
