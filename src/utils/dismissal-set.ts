/**
 * Dismissal sets — the policy a dismissal store needs, without the storage.
 *
 * Anything a user can dismiss accumulates ids, and every such store has needed
 * the same three things: add without duplicating, drop ids the live set no longer
 * contains, and persist ONLY when something actually changed. The third is the
 * one that gets hand-rolled and forgotten, so it's encoded in the return type
 * here: **`undefined` means no change, so don't write.** A caller that ignores it
 * still behaves correctly, it just writes more than it needs to.
 *
 * Storage is deliberately out of scope. The announcement carousel keeps its set
 * in a cookie because the SERVER reads it to render at the right height from
 * frame 0 (see `announcements-dismissed-cookie.ts`), while the generator's
 * experimental warnings use localStorage — nothing there renders during SSR.
 * Unifying that would mean putting a hydration-exact invariant and a plain
 * client store behind one interface, for no gain.
 *
 * Ids are generic: announcements dismiss `number`, experimental warnings
 * dismiss `string`.
 */

/**
 * Add one or more ids, preserving existing order and appending new ones in the
 * order given. Returns `undefined` when every id was already dismissed.
 */
export function addDismissals<T>(dismissed: readonly T[], ids: T | readonly T[]): T[] | undefined {
  const incoming = Array.isArray(ids) ? (ids as readonly T[]) : [ids as T];
  const existing = new Set(dismissed);
  const added = incoming.filter((id) => !existing.has(id));
  if (!added.length) return undefined;
  return [...dismissed, ...new Set(added)];
}

/**
 * Drop dismissed ids that are no longer in `live` — an edited message's orphan, a
 * deleted announcement — which is what keeps the stored set bounded by what
 * exists rather than by everything a user has ever dismissed. Returns `undefined`
 * when nothing was stale.
 *
 * ⚠️ `live` must be the RESOLVED set. An empty or not-yet-loaded `live` prunes
 * everything, so callers gate on their data having arrived — "no live ids" and
 * "haven't loaded the live ids" are indistinguishable from in here.
 */
export function pruneDismissals<T>(dismissed: readonly T[], live: Iterable<T>): T[] | undefined {
  const liveSet = live instanceof Set ? (live as Set<T>) : new Set(live);
  const kept = dismissed.filter((id) => liveSet.has(id));
  if (kept.length === dismissed.length) return undefined;
  return kept;
}
