import { Group, Stack } from '@mantine/core';
import { useMemo, useState } from 'react';
import type { CreatorShopItem } from '~/components/CreatorShop/creator-shop.util';
import { sectionIcons } from '~/components/CreatorShop/section-meta';
import { SectionHeader } from '~/components/CreatorShop/Storefront/SectionHeader';
import { ShopItemGrid } from '~/components/CreatorShop/Storefront/ShopItemGrid';
import type { SortKey } from '~/components/CreatorShop/Storefront/storefront.constants';
import { SORT_OPTIONS } from '~/components/CreatorShop/Storefront/storefront.constants';
import { creatorShopFilterTypes } from '~/components/CreatorShop/Submit/submit.constants';
import { ShopFiltersDropdown } from '~/components/CosmeticShop/ShopFiltersDropdown';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import type { GetShopInput } from '~/server/schema/cosmetic-shop.schema';

export function CosmeticsSection({
  items,
  ownedCosmeticIds,
  ownerUserId,
}: {
  items: CreatorShopItem[];
  ownedCosmeticIds: Set<number>;
  ownerUserId: number;
}) {
  const [filters, setFilters] = useState<GetShopInput>({});
  const [sort, setSort] = useState<SortKey>('newest');

  const cosmetics = useMemo(() => {
    let list = [...items];
    const types = filters.cosmeticTypes;
    if (types?.length) list = list.filter((c) => types.includes(c.cosmetic.type));
    switch (sort) {
      case 'price-asc':
        list.sort((a, b) => a.unitAmount - b.unitAmount);
        break;
      case 'price-desc':
        list.sort((a, b) => b.unitAmount - a.unitAmount);
        break;
      case 'name':
        list.sort((a, b) => a.title.localeCompare(b.title));
        break;
    }
    return list;
  }, [items, filters, sort]);

  return (
    <Stack gap="md">
      <SectionHeader
        icon={sectionIcons.cosmetics}
        title="Cosmetics"
        right={
          <Group gap="xs" wrap="nowrap">
            <SelectMenuV2
              label={SORT_OPTIONS.find((o) => o.value === sort)?.label ?? 'Sort'}
              value={sort}
              onClick={(v) => setSort(v as SortKey)}
              options={SORT_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
            />
            <ShopFiltersDropdown
              filters={filters}
              setFilters={setFilters}
              availableTypes={creatorShopFilterTypes}
              hideModifiers
            />
          </Group>
        }
      />
      <ShopItemGrid
        items={cosmetics}
        ownedCosmeticIds={ownedCosmeticIds}
        ownerUserId={ownerUserId}
        // Attribute purchases to this storefront — unattributed purchases of
        // sellable items pay the platform the reseller share.
        viaShopUserId={ownerUserId}
      />
    </Stack>
  );
}
