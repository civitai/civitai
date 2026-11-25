/**
 * Whether the remove flow offers "strike the owners" for this selection: never when it includes a
 * service review image, whose owner is the buyer who posted it rather than its maker. The server
 * leaves those images out of a strike whatever the form posts (`strikeBatchOwners`).
 */
export function strikeOwnersOffered({
  strike,
  selected,
  reviewImageIds,
}: {
  /** The moderator may strike (`user.strike`). */
  strike: boolean;
  selected: Iterable<string | number>;
  reviewImageIds?: ReadonlySet<string | number>;
}): boolean {
  if (!strike) return false;
  if (!reviewImageIds?.size) return true;
  for (const id of selected) if (reviewImageIds.has(id)) return false;
  return true;
}
