/**
 * Where keyboard focus goes after a chip is removed.
 *
 * `{#each}` is keyed by the entry, so the removed chip's button is unmounted by the invalidation
 * and focus falls to `<body>` — from which a moderator has to tab past everything above a list of
 * up to 200 chips to reach the next one.
 *
 * The whole decision lives here rather than at the call site so it can be tested; what remains in
 * the component is looking the target up in the DOM and calling `.focus()`.
 */
export type ChipFocusTarget =
  /** The remove control of this entry's chip. */
  | { kind: 'chip'; entry: string }
  /** No chip to land on. The filter input, because it is the only control that brings chips back. */
  | { kind: 'filter' };

export function chipFocusTarget(
  visible: string[],
  position: number,
  item: string
): ChipFocusTarget {
  // The removal did not take: the server refused it (`fail(409)` on a stale page is a state this
  // action returns deliberately), or the list re-rendered for some other reason. Returning the
  // user to the chip they were on is correct by construction here rather than by luck of the
  // index still resolving to the same entry.
  if (visible.includes(item)) return { kind: 'chip', entry: item };

  // Otherwise the entry that took its place, so a run of removals walks down the list; the
  // previous one when the last chip went; and the first when `indexOf` returned -1 because the
  // captured list is not the one we are looking at any more.
  const next = position < 0 ? visible[0] : (visible[position] ?? visible[position - 1]);

  return next === undefined ? { kind: 'filter' } : { kind: 'chip', entry: next };
}
