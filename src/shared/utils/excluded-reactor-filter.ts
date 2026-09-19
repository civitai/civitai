/**
 * `AND r."userId" NOT IN (...)` for the metric-excluded users, or `''` when the list is
 * empty. Emitted as literal SQL rather than a bound parameter because the reaction
 * queries run through `templateHandler`, which interpolates; a string is the one value
 * both template handlers pass through verbatim, so one snippet serves both.
 *
 * Lives in `~/shared/` with no imports because the notification processors that use it
 * are in the client graph — `prepareMessage` renders there — and a dynamic import does
 * not keep a module out of the client bundle.
 *
 * The column is hardcoded rather than a parameter. Every reaction aggregate aliases its
 * reaction table `r`, and a parameter here would be raw SQL text that the integer guard
 * beside it does not cover — while reading as though it did. A caller passing the wrong
 * alias (`i."userId"` in the post job, which joins `Image i`) is valid SQL that filters
 * by the post's OWNER instead of the reactor.
 *
 * Non-integer ids throw. They cannot arrive from `metric-excluded-users.service`, which
 * already coerces — but this builds SQL text, and dropping an unexpected id would
 * silently keep counting that user's reactions, which is the bug this exists to fix.
 */
export function excludedReactorFilter(excludedUserIds: number[]) {
  if (!excludedUserIds.length) return '';
  for (const id of excludedUserIds) {
    if (!Number.isInteger(id)) throw new Error(`non-integer excluded user id: ${id}`);
  }
  return `AND r."userId" NOT IN (${excludedUserIds.join(',')})`;
}
