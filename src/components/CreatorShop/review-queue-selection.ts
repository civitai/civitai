/**
 * Which queue item to select after the list changes. A verdict removes the reviewed item, so the
 * selection carries on to the item after it instead of jumping back to the top.
 */
export const nextQueueSelection = (
  prev: { id: number }[],
  items: { id: number }[],
  current: number | null
): number | null => {
  if (current != null && items.some((i) => i.id === current)) return current;
  const at = current == null ? -1 : prev.findIndex((i) => i.id === current);
  const next =
    at >= 0 ? prev.slice(at + 1).find((p) => items.some((i) => i.id === p.id)) : undefined;
  return next?.id ?? items[0]?.id ?? null;
};
