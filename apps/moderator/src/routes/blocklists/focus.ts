/**
 * Where keyboard focus goes after a chip is removed.
 *
 * `{#each}` is keyed by the entry, so the removed chip's button is unmounted by the invalidation
 * and focus falls to `<body>` — from which a moderator has to tab past everything above a list of
 * up to 200 chips to reach the next one. Returning the entry that took the removed one's place
 * makes repeated removal work without leaving the list.
 *
 * `null` means there is no chip to land on and the caller should fall back to the filter input.
 * It is deliberately NOT the same as "focus the previous chip": emptying the list is the one case
 * where staying among the chips is impossible.
 */
export function chipFocusTarget(visible: string[], position: number): string | null {
  if (position < 0) return visible[0] ?? null;
  // The entry now AT that index, which is the one that slid up. Falling back to `position - 1`
  // covers removing the last chip; both are undefined once the list is empty.
  return visible[position] ?? visible[position - 1] ?? null;
}
