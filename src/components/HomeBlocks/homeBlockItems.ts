import { HOME_BLOCK_ITEMS_PER_ROW } from '~/shared/constants/home-block.constants';

export const ITEMS_PER_ROW = HOME_BLOCK_ITEMS_PER_ROW;

type CappableItem = { user?: { id: number } | null };

/**
 * Trim to the visible slice, capping how many items one creator can contribute.
 *
 * Fed the whole fetched pool rather than the visible slice, so a capped-out creator's
 * items are replaced by other creators' rather than leaving holes in the grid — which
 * is why every caller pairs this with a fetch `limit` well above `rows * ITEMS_PER_ROW`.
 * Items with no resolvable creator are always kept; they can't be attributed.
 */
export function capPerUser<T extends CappableItem>(
  items: T[],
  itemsToShow: number,
  maxPerUser?: number
) {
  if (!maxPerUser) return items.slice(0, itemsToShow);

  const perUserCount = new Map<number, number>();
  const capped: T[] = [];
  for (const item of items) {
    if (capped.length >= itemsToShow) break;
    const userId = item.user?.id;
    if (userId == null) {
      capped.push(item);
      continue;
    }
    const count = perUserCount.get(userId) ?? 0;
    if (count >= maxPerUser) continue;
    perUserCount.set(userId, count + 1);
    capped.push(item);
  }
  return capped;
}
