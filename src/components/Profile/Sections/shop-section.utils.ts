// Matches the grid's `minmax(280px, 1fr)` track (cards carry their own 8px margins inside it).
export const SHOP_CARD_MIN_WIDTH = 280;

export const getShopRowColumns = (containerWidth: number) =>
  Math.max(1, Math.floor(containerWidth / SHOP_CARD_MIN_WIDTH));

// One row of the profile Shop section: the creator's featured items first, in their order,
// then topped up from their other cosmetics (already buyer-visible server-side) until the row
// is full. Never more than `columns` items, so the grid never wraps to a second row.
export const pickShopRowItems = <T extends { id: number }>({
  featured,
  cosmetics,
  columns,
}: {
  featured: T[];
  cosmetics: T[];
  columns: number;
}): T[] => {
  const seen = new Set<number>();
  const row: T[] = [];
  for (const item of [...featured, ...cosmetics]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    row.push(item);
  }
  return row.slice(0, Math.max(1, columns));
};

// The profile Shop section shows for a published shop with anything a visitor can buy: a
// cosmetic, or an Active service where the storefront shows its Services section (the link
// lands on that section). Services here are already Active-only, so a Draft never counts.
export const shopSectionHasItems = ({
  enabled,
  cosmeticCount,
  activeServiceCount,
  servicesShown,
}: {
  enabled: boolean;
  cosmeticCount: number;
  activeServiceCount: number;
  servicesShown: boolean;
}) => enabled && (cosmeticCount > 0 || (servicesShown && activeServiceCount > 0));
