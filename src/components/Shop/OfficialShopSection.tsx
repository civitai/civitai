import { useMemo } from 'react';
import type { ShopFilters } from '~/components/CosmeticShop/ShopFiltersDropdown';
import { ShopBrowsePagination } from '~/components/Shop/ShopBrowseControls';
import { browseShopItems, shopBrowseKey, usePagedList } from '~/components/Shop/shop-browse';
import { ShopItem } from '~/components/Shop/ShopItem';
import { ShopSection } from '~/components/Shop/ShopSection';
import type { CosmeticShopSectionMeta } from '~/server/schema/cosmetic-shop.schema';
import { CIVITAI_SHOP_ATTRIBUTION } from '~/server/schema/cosmetic-shop.schema';
import type { CosmeticShopSort } from '~/server/common/enums';
import type { RouterOutput } from '~/types/router';

export type OfficialShopSectionData = RouterOutput['cosmeticShop']['getShop'][number];

// One mod-curated section on /shop. The filters and sort come from the page's
// single control bar, but each section pages independently — they're separate
// grids, and a shared page number would be meaningless across them.
export function OfficialShopSection({
  section,
  filters,
  sort,
  pageSize,
  ownedCosmeticIds,
  wishlistedIds,
  className,
}: {
  section: OfficialShopSectionData;
  filters: ShopFilters;
  sort: CosmeticShopSort;
  pageSize: number;
  ownedCosmeticIds: Set<number>;
  wishlistedIds: Set<number>;
  className?: string;
}) {
  const entries = section.items;
  const matched = useMemo(
    () =>
      browseShopItems({
        entries,
        shopItemOf: (entry) => entry.shopItem,
        // When the mod added it to this section — the same date the "New!"
        // badge marks, and the only listing date an official item has.
        listedAtOf: (entry) => entry.createdAt,
        filters,
        sort,
        ownedCosmeticIds,
        wishlistedIds,
      }),
    [entries, filters, sort, ownedCosmeticIds, wishlistedIds]
  );
  const { items, page, setPage, totalPages } = usePagedList(
    matched,
    pageSize,
    shopBrowseKey(filters, sort, pageSize)
  );

  if (!matched.length) return null;

  const meta = section.meta as CosmeticShopSectionMeta;

  return (
    <ShopSection
      title={section.title}
      description={section.description}
      imageUrl={section.image?.url}
      hideTitle={meta.hideTitle}
      className={className}
    >
      <ShopSection.Items>
        {items.map(({ shopItem, createdAt }) => (
          <ShopItem
            key={shopItem.id}
            item={shopItem}
            sectionItemCreatedAt={createdAt}
            alreadyOwned={ownedCosmeticIds.has(shopItem.cosmeticId)}
            wishlisted={wishlistedIds.has(shopItem.id)}
            creator={shopItem.cosmetic.creator}
            viaShopUserId={CIVITAI_SHOP_ATTRIBUTION}
          />
        ))}
      </ShopSection.Items>
      <ShopBrowsePagination page={page} onChange={setPage} totalPages={totalPages} />
    </ShopSection>
  );
}
