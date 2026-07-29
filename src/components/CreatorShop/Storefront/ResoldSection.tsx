import { Stack } from '@mantine/core';
import { useMemo, useState } from 'react';
import type { CreatorShopData } from '~/components/CreatorShop/creator-shop.util';
import { sectionIcons } from '~/components/CreatorShop/section-meta';
import { SectionHeader } from '~/components/CreatorShop/Storefront/SectionHeader';
import { ShopItemGrid } from '~/components/CreatorShop/Storefront/ShopItemGrid';
import { creatorShopFilterTypes } from '~/components/CreatorShop/Submit/submit.constants';
import { ShopFiltersDropdown } from '~/components/CosmeticShop/ShopFiltersDropdown';
import type { GetShopInput } from '~/server/schema/cosmetic-shop.schema';

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
  const [filters, setFilters] = useState<GetShopInput>({});

  const filtered = useMemo(() => {
    const types = filters.cosmeticTypes;
    if (!types?.length) return items;
    return items.filter((c) => types.includes(c.cosmetic.type));
  }, [items, filters]);

  if (!items.length) return null;

  return (
    <Stack gap="md">
      <SectionHeader
        icon={sectionIcons.resold}
        title="From other creators"
        right={
          <ShopFiltersDropdown
            filters={filters}
            setFilters={setFilters}
            availableTypes={creatorShopFilterTypes}
            hideModifiers
          />
        }
      />
      {/* viaShopUserId credits this shop owner with the reseller share on purchase. */}
      <ShopItemGrid
        items={filtered}
        ownedCosmeticIds={ownedCosmeticIds}
        ownerUserId={viaShopUserId}
        viaShopUserId={viaShopUserId}
      />
    </Stack>
  );
}
