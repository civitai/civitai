/**
 * Where keyboard focus goes when a chip's controls disappear.
 *
 * `{#each}` is keyed by the entry, so a removal unmounts the button that was just activated and
 * focus falls to `<body>` — from which a moderator has to tab past everything above a list of up to
 * 200 chips to reach the next one. Dismissing a confirm unmounts the popover the same way.
 *
 * 🔴 The GUARDS live here too, not just the choice of entry. Moving focus when it was not ours to
 * move is worse than leaving it: it yanks a moderator out of the filter box or a half-typed bulk
 * paste and into a button, where the next Space or Enter opens a confirm they did not ask for.
 * Those guards were previously plain `if`s at the call site, where nothing could see them — and a
 * third guard of exactly this kind shipped MISSING altogether, which is how Escape came to yank
 * focus out of the filter box. In here, hardcoding any of them to `true` fails a test.
 */
export type ChipFocusTarget =
  /** Leave focus where it is. */
  | { kind: 'none' }
  /** The remove control of this entry's chip. */
  | { kind: 'chip'; entry: string }
  /** No chip to land on. The filter input, because it is the only control that brings chips back. */
  | { kind: 'filter' };

const LEAVE: ChipFocusTarget = { kind: 'none' };

export type RemovalFocusGuards = {
  /** Was focus inside the removed chip's own form when it was submitted? */
  focusWasInForm: boolean;
  /** Is the page still showing the blocklist that was submitted against? */
  sameType: boolean;
};

export function chipFocusTarget(
  visible: string[],
  position: number,
  item: string,
  { focusWasInForm, sameType }: RemovalFocusGuards
): ChipFocusTarget {
  // Not our focus to move: it was somewhere else on the page when the removal was submitted.
  if (!focusWasInForm) return LEAVE;
  // A removal can outlive the tab. Clicking another tab mid-flight swaps the entries for a
  // different type's, and "the entry at that index" would then be an unrelated blocklist.
  if (!sameType) return LEAVE;

  // The removal did not take: the server refused it (`fail(409)` on a stale page is a state this
  // action returns deliberately), or the list re-rendered for another reason. Returning the user to
  // the chip they were on is then correct by construction, rather than by luck of the index still
  // resolving to the same entry.
  if (visible.includes(item)) return { kind: 'chip', entry: item };

  // Otherwise the entry that took its place, so a run of removals walks down the list; the previous
  // one when the last chip went; and the first when `indexOf` returned -1 because the captured list
  // is not the one we are looking at any more.
  const next = position < 0 ? visible[0] : visible[position] ?? visible[position - 1];

  return next === undefined ? { kind: 'filter' } : { kind: 'chip', entry: next };
}

/**
 * Where focus goes when a confirm popover is dismissed by Cancel or Escape.
 *
 * Escape is a `svelte:window` handler, so it fires from anywhere on the page — including from the
 * filter input while the popover is still open and visible, which is a reflex a moderator will
 * actually have. Without the guard that dismissal pulls them out of the field they are typing in.
 * Cancel passes it for free, since clicking Cancel puts focus inside the popover.
 */
export function confirmDismissTarget(
  confirming: string | null,
  focusWasInChipForm: boolean
): ChipFocusTarget {
  if (!confirming || !focusWasInChipForm) return LEAVE;
  return { kind: 'chip', entry: confirming };
}
