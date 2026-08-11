import { Stack } from '@mantine/core';
import { useMemo, useState } from 'react';
import { useQueryWishlistedShopItems } from '~/components/CosmeticShop/cosmetic-shop.util';
import type { ShopFilters } from '~/components/CosmeticShop/ShopFiltersDropdown';
import type { CreatorShopData } from '~/components/CreatorShop/creator-shop.util';
import { sectionIcons } from '~/components/CreatorShop/section-meta';
import { SectionHeader } from '~/components/CreatorShop/Storefront/SectionHeader';
import { ShopItemGrid } from '~/components/CreatorShop/Storefront/ShopItemGrid';
import { creatorShopFilterTypes } from '~/components/CreatorShop/Submit/submit.constants';
import { NoContent } from '~/components/NoContent/NoContent';
import { ShopBrowseControls, ShopBrowsePagination } from '~/components/Shop/ShopBrowseControls';
import { browseShopItems, shopBrowseKey, usePagedList } from '~/components/Shop/shop-browse';
import { CosmeticShopSort } from '~/server/common/enums';
import { COSMETIC_SHOP_DEFAULT_PAGE_SIZE } from '~/shared/constants/cosmetic-shop.constants';

export function ResoldSection({
  items,
  ownedCosmeticIds,
  viaShopUserId,
}: {
  items: CreatorShopData['resold'];
  ownedCosmeticIds: Set<number>;
  // Also the shop owner whose page this is; drives purchase attribution and
  // (in ShopItemGrid) whether to show per-card creator attribution.
  viaShopUserId: number;
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
    items: filtered,
    page,
    setPage,
    totalPages,
  } = usePagedList(matched, pageSize, shopBrowseKey(filters, sort, pageSize));

  if (!items.length) return null;

  return (
    <Stack gap="md">
      <SectionHeader
        icon={sectionIcons.resold}
        title="From other creators"
        right={
          <ShopBrowseControls
            sort={sort}
            onSortChange={setSort}
            pageSize={pageSize}
            onPageSizeChange={setPageSize}
            filters={filters}
            setFilters={setFilters}
            availableTypes={creatorShopFilterTypes}
          />
        }
      />
      {matched.length ? (
        <>
          {/* viaShopUserId credits this shop owner with the reseller share on purchase. */}
          <ShopItemGrid
            items={filtered}
            ownedCosmeticIds={ownedCosmeticIds}
            ownerUserId={viaShopUserId}
            viaShopUserId={viaShopUserId}
          />
          <ShopBrowsePagination page={page} onChange={setPage} totalPages={totalPages} />
        </>
      ) : (
        <NoContent message="No cosmetics match your filters." />
      )}
    </Stack>
  );
}
