// Postgres caps bind parameters at 32767. A `userId: { notIn: [...] }` (Prisma) or a
// raw `... NOT IN (...)` is a NEGATION filter: Prisma auto-splits a positive `in` across
// multiple queries when it exceeds the bind-parameter limit, but it CANNOT split a `notIn`,
// so once the list crosses the limit the engine throws P2029 ("Query parameter limit
// exceeded ... the negation filters used prevent the query from being split") and the whole
// query 500s. `blockedByUsers` (everyone who has blocked the viewer) is unbounded, so a
// heavily-blocked account's combined exclusion list can exceed the limit.
//
// 30000 leaves ~2767 bind-params of headroom below 32767 for the rest of each query (the
// other params on these comment/bounty/user queries are each <10), so the cap is safe.
export const MAX_EXCLUDED_USER_IDS = 30000;

/**
 * Build the bounded, de-duplicated list of user ids to exclude (via a Prisma `notIn` /
 * raw `NOT IN`) from a query, given the viewer's three block/hidden lists.
 *
 * The three lists overlap heavily (a mutual block appears in BOTH `blockedUsers` and
 * `blockedByUsers`), so we de-dupe with a Set, then cap to `MAX_EXCLUDED_USER_IDS` to keep
 * the query under the Postgres bind-parameter limit (see the constant comment for why a
 * `notIn` cannot be auto-split and 500s with P2029 otherwise).
 *
 * ORDERING IS LOAD-BEARING — DO NOT REORDER. `.slice` drops the TAIL on overflow, so the
 * spread order is an intentional safety priority:
 *   1. `hiddenUsers`     — the viewer's curated hide list (kept; small + viewer's intent)
 *   2. `blockedByUsers`  — INVOLUNTARY: everyone who has blocked the viewer (harassment-
 *                          relevant — must stay excluded so a harasser who blocked the
 *                          viewer cannot then surface to them)
 *   3. `blockedUsers`    — the viewer's OWN mute list (LAST, so it is sacrificed FIRST on
 *                          overflow)
 * On the pathological >30k-id case the viewer's own mute list is the part that may leak a
 * few comments through — far preferable to a hard 500 that breaks the surface entirely, and
 * deliberately preferred over leaking the involuntary blocked-by list. A future refactor
 * MUST NOT silently reorder these spreads.
 *
 * `isContentOwner`: set ONLY on surfaces where the viewer is the owner of the content being
 * engaged with (a creator looking at comments/reviews/reactions on their OWN model, image,
 * post, etc.). There we DROP `blockedByUsers`: the involuntary "someone blocked me" list
 * otherwise lets a downvoter/commenter hide their trail on the owner's own content simply by
 * blocking the owner — and stops the owner from seeing or reporting it. Everywhere else
 * (viewer is NOT the owner) `blockedByUsers` stays, preserving the anti-harassment guarantee
 * that a harasser who blocked the viewer cannot resurface to them.
 */
export function boundExcludedUserIds(
  hiddenUsers: number[],
  blockedByUsers: number[],
  blockedUsers: number[],
  options?: { isContentOwner?: boolean }
): number[] {
  const involuntaryBlockedBy = options?.isContentOwner ? [] : blockedByUsers;
  return [...new Set([...hiddenUsers, ...involuntaryBlockedBy, ...blockedUsers])].slice(
    0,
    MAX_EXCLUDED_USER_IDS
  );
}
