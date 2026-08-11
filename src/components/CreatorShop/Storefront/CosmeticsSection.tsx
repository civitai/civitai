import { Stack } from '@mantine/core';
import { useMemo, useState } from 'react';
import { useQueryWishlistedShopItems } from '~/components/CosmeticShop/cosmetic-shop.util';
import type { ShopFilters } from '~/components/CosmeticShop/ShopFiltersDropdown';
import type { CreatorShopItem } from '~/components/CreatorShop/creator-shop.util';
import { sectionIcons } from '~/components/CreatorShop/section-meta';
import { SectionHeader } from '~/components/CreatorShop/Storefront/SectionHeader';
import { ShopItemGrid } from '~/components/CreatorShop/Storefront/ShopItemGrid';
import { shopFilterTypesWithPack } from '~/components/CreatorShop/Submit/submit.constants';
import { NoContent } from '~/components/NoContent/NoContent';
import { ShopBrowseControls, ShopBrowsePagination } from '~/components/Shop/ShopBrowseControls';
import { browseShopItems, shopBrowseKey, usePagedList } from '~/components/Shop/shop-browse';
import { CosmeticShopSort } from '~/server/common/enums';
import { COSMETIC_SHOP_DEFAULT_PAGE_SIZE } from '~/shared/constants/cosmetic-shop.constants';

export function CosmeticsSection({
  items,
  ownedCosmeticIds,
  ownerUserId,
}: {
  items: CreatorShopItem[];
  ownedCosmeticIds: Set<number>;
  ownerUserId: number;
}) {
  const [filters, setFilters] = useState<ShopFilters>({});
  const [sort, setSort] = useState(CosmeticShopSort.Newest);
  const [pageSize, setPageSize] = useState<number>(COSMETIC_SHOP_DEFAULT_PAGE_SIZE);
  const { wishlistedIds } = useQueryWishlistedShopItems();

  const matched = useMemo(
    () =>
      browseShopItems({
        entries: items,
        shopItemOf: (item) => item,
        filters,
        sort,
        ownedCosmeticIds,
        wishlistedIds,
      }),
    [items, filters, sort, ownedCosmeticIds, wishlistedIds]
  );
  const {
    items: cosmetics,
    page,
    setPage,
    totalPages,
  } = usePagedList(matched, pageSize, shopBrowseKey(filters, sort, pageSize));

  return (
    <Stack gap="md">
      <SectionHeader
        icon={sectionIcons.cosmetics}
        title="Cosmetics"
        right={
          <ShopBrowseControls
            sort={sort}
            onSortChange={setSort}
            pageSize={pageSize}
            onPageSizeChange={setPageSize}
            filters={filters}
            setFilters={setFilters}
            availableTypes={shopFilterTypesWithPack}
          />
        }
      />
      {matched.length ? (
        <>
          <ShopItemGrid
            items={cosmetics}
            ownedCosmeticIds={ownedCosmeticIds}
            ownerUserId={ownerUserId}
            // Attribute purchases to this storefront — unattributed purchases of
            // sellable items pay the platform the reseller share.
            viaShopUserId={ownerUserId}
          />
          <ShopBrowsePagination page={page} onChange={setPage} totalPages={totalPages} />
        </>
      ) : (
        <NoContent message="No cosmetics match your filters." />
      )}
    </Stack>
  );
}
