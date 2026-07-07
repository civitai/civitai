import { Group, Select, Stack, Text, Title } from '@mantine/core';
import { useMemo, useState } from 'react';
import type { CreatorShopItem } from '~/components/CreatorShop/creator-shop.util';
import { SectionAccent } from '~/components/CreatorShop/Storefront/SectionAccent';
import { ShopItemGrid } from '~/components/CreatorShop/Storefront/ShopItemGrid';
import type { SortKey } from '~/components/CreatorShop/Storefront/storefront.constants';
import { SORT_OPTIONS } from '~/components/CreatorShop/Storefront/storefront.constants';
import { ShopFiltersDropdown } from '~/components/CosmeticShop/ShopFiltersDropdown';
import type { GetShopInput } from '~/server/schema/cosmetic-shop.schema';

type StorefrontFilters = GetShopInput & { modifier?: 'owned' | 'notOwned' };

export function CosmeticsSection({
  items,
  ownedCosmeticIds,
}: {
  items: CreatorShopItem[];
  ownedCosmeticIds: Set<number>;
}) {
  const [filters, setFilters] = useState<StorefrontFilters>({});
  const [sort, setSort] = useState<SortKey>('newest');

  const cosmetics = useMemo(() => {
    let list = [...items];
    const types = filters.cosmeticTypes;
    if (types?.length) list = list.filter((c) => types.includes(c.cosmetic.type));
    if (filters.modifier === 'owned') list = list.filter((c) => ownedCosmeticIds.has(c.cosmeticId));
    else if (filters.modifier === 'notOwned')
      list = list.filter((c) => !ownedCosmeticIds.has(c.cosmeticId));
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
  }, [items, filters, sort, ownedCosmeticIds]);

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <div>
          <Group gap={10} align="center">
            <SectionAccent />
            <Title order={4}>Cosmetics</Title>
          </Group>
          <Text size="xs" c="dimmed">
            Badges, profile backgrounds &amp; avatar decorations that can be purchased and used on
            your profile.
          </Text>
        </div>
        <Group gap="xs" wrap="nowrap">
          <ShopFiltersDropdown filters={filters} setFilters={setFilters} />
          <Select
            size="sm"
            radius="xl"
            w={170}
            value={sort}
            onChange={(v) => setSort((v as SortKey) ?? 'newest')}
            data={SORT_OPTIONS}
          />
        </Group>
      </Group>
      <ShopItemGrid
        items={cosmetics}
        cols={{ base: 1, xs: 2, sm: 3, md: 4 }}
        ownedCosmeticIds={ownedCosmeticIds}
      />
    </Stack>
  );
}
