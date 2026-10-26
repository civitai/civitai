import { seededRng, shuffle } from '@civitai/shared/post-scheduling';

/** Rows the home block shows, and the most columns MasonryProvider ever lays out (its default). */
export const SHOP_BLOCK_ROWS = 2;
const SHOP_BLOCK_MAX_COLUMNS = 7;

/**
 * What a rotating block falls back to when its metadata leaves these out. `maxItems` fills the
 * widest row layout, so a wide screen never shows an empty slot while the section has more.
 */
export const COSMETIC_SHOP_ROTATION_DEFAULTS = {
  maxItems: SHOP_BLOCK_ROWS * SHOP_BLOCK_MAX_COLUMNS,
  rotateHours: 3,
} as const;

type ShopBlockMeta = { maxItems?: number; random?: boolean } | undefined;

/** How many items a shop block shows: its own `maxItems`, else a full widest-row grid when it rotates, else all. */
export function shopBlockMaxItems(meta: ShopBlockMeta) {
  return meta?.maxItems ?? (meta?.random ? COSMETIC_SHOP_ROTATION_DEFAULTS.maxItems : undefined);
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * The section's items in this window's order. Seeded by the time bucket and the section, so every
 * visitor in a window gets the same order, and the order changes only when the bucket does.
 * Applied after the shared block cache, never inside it: that entry is keyed by section and also
 * serves blocks of the same section that do not rotate.
 */
export function rotateShopSectionItems<T>(
  items: T[],
  {
    sectionId,
    rotateHours = COSMETIC_SHOP_ROTATION_DEFAULTS.rotateHours,
    now,
  }: { sectionId: number; rotateHours?: number; now: number }
): T[] {
  // Metadata is cast rather than parsed, so a hand-written 0 or negative has to land somewhere.
  const windowMs = Math.max(1, rotateHours) * HOUR_MS;
  const bucket = Math.floor(now / windowMs);
  return shuffle(items, seededRng(Math.imul(bucket, 0x9e3779b1) ^ sectionId));
}

type ShopBlockItem = {
  shopItem: {
    addedById: number | null;
    cosmetic: { creator: { id: number } | null } | null;
  };
};

/**
 * What one viewer sees of a shop block. The block body is shared by every viewer, so the
 * per-viewer block filter the shop page applies on the server has to happen here: the same rule,
 * a cosmetic's creator or a pack's lister, either direction of the block. That rule also lives in
 * `getShopSectionsWithItems`; a change to one belongs in the other.
 */
export function visibleShopBlockItems<T extends ShopBlockItem>(
  items: T[],
  { blockRelations, maxItems }: { blockRelations: Map<number, boolean>; maxItems?: number }
): T[] {
  const visible = items.filter(({ shopItem }) => {
    const sellerId = shopItem.cosmetic ? shopItem.cosmetic.creator?.id : shopItem.addedById;
    return sellerId == null || !blockRelations.has(sellerId);
  });
  return maxItems ? visible.slice(0, maxItems) : visible;
}
