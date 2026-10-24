/**
 * Which ids a bulk moderation form actually POSTs.
 *
 * The bulk forms in this app all post one form entry per id — `<input type="hidden" name="reviewIds">`
 * repeated — because every consumer reads them back with `form.getAll(name)`; the parsed object carries
 * only the LAST value for a repeated name, so a joined string would silently act on one row.
 *
 * The narrowing is the part that matters. A selection outlives the list it was made in: the operator
 * ticks three rows, types into the filter box, and two of them leave the screen. Posting the raw
 * selection then deletes rows they can no longer see, and counting it tells them a number that does not
 * match what is in front of them. Both halves come from here, so the confirmation and the payload
 * cannot disagree — which is the actual failure this guards, not the filtering itself.
 *
 * Order is the rows', not the selection's: `getAll` consumers do not care, and reading in row order is
 * O(n) rather than O(n·m).
 */
export function postedIds<T extends { id: number }>(
  rows: readonly T[],
  selected: { has(id: number): boolean }
): number[] {
  return rows.filter((r) => selected.has(r.id)).map((r) => r.id);
}
