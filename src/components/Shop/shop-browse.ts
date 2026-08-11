import { useMemo, useState } from 'react';
import type { ShopFilters } from '~/components/CosmeticShop/ShopFiltersDropdown';
import { CosmeticShopSort } from '~/server/common/enums';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';

/**
 * Shared filter/sort/page behaviour for every shop grid that already holds its
 * whole list client-side — the official /shop sections and both creator
 * storefront sections. The community hub does the same thing server-side
 * (`getCommunityCosmetics`), because it browses the entire catalog; the two
 * implementations are kept deliberately in step, so a rule changed here needs
 * changing there too.
 */

/** The shop-item fields the filters and sorts read, whatever else an entry wraps. */
export type ShopBrowseItem = {
  id: number;
  cosmeticId: number;
  title: string;
  unitAmount: number;
  reviewedAt?: Date | null;
  availableQuantity?: number | null;
  availableTo?: Date | null;
  meta?: unknown;
  cosmetic: { type: CosmeticType };
};

const metaOf = (item: ShopBrowseItem) => (item.meta ?? {}) as CosmeticShopItemMeta;

export function browseShopItems<T>({
  entries,
  shopItemOf,
  listedAtOf,
  filters,
  sort,
  ownedCosmeticIds,
  wishlistedIds,
}: {
  entries: T[];
  shopItemOf: (entry: T) => ShopBrowseItem;
  /**
   * Overrides the item's own date for Newest/Oldest. The official sections pass
   * when the item was added to the section, which is both the mod's listing
   * order and what the "New!" badge already marks.
   */
  listedAtOf?: (entry: T) => Date | null | undefined;
  filters: ShopFilters;
  sort: CosmeticShopSort;
  ownedCosmeticIds: Set<number>;
  wishlistedIds: Set<number>;
}): T[] {
  const { cosmeticTypes, modifier, wishlisted, limited, acceptsBlueBuzz } = filters;

  const filtered = entries.filter((entry) => {
    const item = shopItemOf(entry);
    if (cosmeticTypes?.length && !cosmeticTypes.includes(item.cosmetic.type)) return false;
    if (wishlisted && !wishlistedIds.has(item.id)) return false;
    if (modifier) {
      const owned = ownedCosmeticIds.has(item.cosmeticId);
      if (modifier === 'owned' && !owned) return false;
      // Owning a content decoration doesn't stop you buying another, which is
      // also why the card never marks them owned — so they stay in "not owned".
      const repeatable = item.cosmetic.type === CosmeticType.ContentDecoration;
      if (modifier === 'notOwned' && owned && !repeatable) return false;
    }
    if (limited && item.availableQuantity == null && item.availableTo == null) return false;
    if (acceptsBlueBuzz && !metaOf(item).acceptsBlueBuzz) return false;
    return true;
  });

  const listedAt = (entry: T) => {
    const date = listedAtOf?.(entry) ?? shopItemOf(entry).reviewedAt;
    return date ? new Date(date).getTime() : null;
  };
  // Newest resolves ties by id so a page boundary can't drop or repeat a card,
  // matching what the server-paged hub does for the same reason. An item with no
  // listing date sorts as the oldest in both directions, the same way the hub's
  // `reviewedAt` NULLS LAST/FIRST does — falling back to its submission time
  // would order the two surfaces differently.
  const byNewest = (a: T, b: T) => {
    const aAt = listedAt(a);
    const bAt = listedAt(b);
    if (aAt == null || bAt == null) {
      if (aAt !== bAt) return aAt == null ? 1 : -1;
    } else if (aAt !== bAt) return bAt - aAt;
    return shopItemOf(b).id - shopItemOf(a).id;
  };

  const compare: Record<CosmeticShopSort, (a: T, b: T) => number> = {
    [CosmeticShopSort.Newest]: byNewest,
    [CosmeticShopSort.Oldest]: (a, b) => -byNewest(a, b),
    [CosmeticShopSort.PriceLowToHigh]: (a, b) =>
      shopItemOf(a).unitAmount - shopItemOf(b).unitAmount || byNewest(a, b),
    [CosmeticShopSort.PriceHighToLow]: (a, b) =>
      shopItemOf(b).unitAmount - shopItemOf(a).unitAmount || byNewest(a, b),
    [CosmeticShopSort.MostPopular]: (a, b) =>
      (metaOf(shopItemOf(b)).purchases ?? 0) - (metaOf(shopItemOf(a)).purchases ?? 0) ||
      byNewest(a, b),
    [CosmeticShopSort.Name]: (a, b) =>
      shopItemOf(a).title.localeCompare(shopItemOf(b).title) || byNewest(a, b),
  };

  return filtered.sort(compare[sort] ?? byNewest);
}

/**
 * Page number that returns to page 1 whenever `resetKey` changes — whatever
 * narrowed the list (filters + sort + page size), since page 7 of the old result
 * set is a blank grid in the new one.
 *
 * Separate from `usePagedList` for the community hub, which pages server-side
 * and so needs the reset without the slicing.
 *
 * Adjusted during render on purpose (React's "adjusting state when a prop
 * changes" pattern) rather than in an effect: an effect would let one render
 * through with the stale page, which on the server-paged hub is a wasted fetch
 * of a page the new filters may not even have.
 */
export function useResettingPage(resetKey: string) {
  const [page, setPage] = useState(1);
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setPage(1);
  }
  return [page, setPage] as const;
}

/**
 * Page state plus the slice, for a list already held client-side. The page is
 * clamped to what exists, so a list that shrinks underneath us never renders an
 * empty page first and corrects after.
 */
export function usePagedList<T>(list: T[], pageSize: number, resetKey: string) {
  const [page, setPage] = useResettingPage(resetKey);

  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const items = useMemo(
    () => list.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [list, currentPage, pageSize]
  );

  return { items, page: currentPage, setPage, totalPages };
}

/** Everything that changes which items a page holds, as one comparable string. */
export function shopBrowseKey(filters: ShopFilters, sort: CosmeticShopSort, pageSize: number) {
  return JSON.stringify([
    filters.cosmeticTypes ?? [],
    filters.modifier ?? null,
    !!filters.wishlisted,
    !!filters.limited,
    !!filters.acceptsBlueBuzz,
    sort,
    pageSize,
  ]);
}
