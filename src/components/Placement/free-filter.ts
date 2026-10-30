/**
 * What a review queue shows, and what stays selected, when the free rows are
 * hidden.
 *
 * Its own module because the queues are pages: nothing under `src/pages` can
 * carry a test — Next treats every file there as a route — and the selection
 * rule below is the half worth testing. Inline in the page it would be a
 * one-line filter whose failure is a bulk action on rows nobody can see.
 */

/** The rows on screen. `showFree` false drops the free ones. */
export function visibleQueueRows<T extends { free: boolean }>(rows: T[], showFree: boolean) {
  return showFree ? rows : rows.filter((row) => !row.free);
}

/**
 * The selection, with anything the filter just hid taken out of it.
 *
 * Approve and Decline are irreversible and both say something about money, so a
 * selection that outlives the rows it was made from acts on placements the owner
 * can no longer see — and the count beside the buttons would still include them.
 *
 * An id whose row is not in `rows` at all is dropped too. Selection only ever
 * comes from loaded rows, so that case is a row that went away underneath it.
 */
export function selectionAfterHidingFree(
  selected: number[],
  rows: { id: number; free: boolean }[]
) {
  return selected.filter((id) => rows.some((row) => row.id === id && !row.free));
}
