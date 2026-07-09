import { Group, Stack, Text, Title } from '@mantine/core';
import type { CreatorShopData } from '~/components/CreatorShop/creator-shop.util';
import { SectionAccent } from '~/components/CreatorShop/Storefront/SectionAccent';
import { ShopItemGrid } from '~/components/CreatorShop/Storefront/ShopItemGrid';

export function ResoldSection({
  items,
  ownedCosmeticIds,
  viaShopUserId,
}: {
  items: CreatorShopData['resold'];
  ownedCosmeticIds: Set<number>;
  viaShopUserId: number;
}) {
  if (!items.length) return null;

  return (
    <Stack gap="md">
      <div>
        <Group gap={10} align="center">
          <SectionAccent />
          <Title order={4}>From other creators</Title>
        </Group>
        <Text size="xs" c="dimmed">
          Cosmetics by other creators, curated into this shop.
        </Text>
      </div>
      {/* viaShopUserId credits this shop owner with the reseller share on purchase. */}
      <ShopItemGrid
        items={items}
        cols={{ base: 2, sm: 3, md: 4 }}
        ownedCosmeticIds={ownedCosmeticIds}
        viaShopUserId={viaShopUserId}
      />
    </Stack>
  );
}
