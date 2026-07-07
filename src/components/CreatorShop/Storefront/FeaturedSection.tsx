import { Group, Paper, Stack, Text, Title } from '@mantine/core';
import { IconStar } from '@tabler/icons-react';
import type { CreatorShopData } from '~/components/CreatorShop/creator-shop.util';
import { ShopItemGrid } from '~/components/CreatorShop/Storefront/ShopItemGrid';
import { GOLD_HEADER_GRADIENT } from '~/components/CreatorShop/Storefront/storefront.constants';

export function FeaturedSection({
  shop,
  displayName,
  ownedCosmeticIds,
}: {
  shop: CreatorShopData;
  displayName: string;
  ownedCosmeticIds: Set<number>;
}) {
  if (shop.featured.length === 0) return null;

  return (
    <Paper withBorder radius="md" p="lg" style={{ overflow: 'hidden' }}>
      <Group
        justify="space-between"
        align="center"
        wrap="nowrap"
        style={{
          margin:
            'calc(-1 * var(--mantine-spacing-lg)) calc(-1 * var(--mantine-spacing-lg)) var(--mantine-spacing-lg)',
          padding: 'var(--mantine-spacing-md) var(--mantine-spacing-lg)',
          background: GOLD_HEADER_GRADIENT,
        }}
      >
        <Group gap={10} align="center" wrap="nowrap">
          <IconStar
            size={26}
            color="var(--mantine-color-white)"
            fill="var(--mantine-color-white)"
          />
          <Stack gap={0}>
            <Title order={3} c="white">
              Featured Items
            </Title>
            <Text size="xs" c="white">
              Hand-picked by {displayName}
            </Text>
          </Stack>
        </Group>
      </Group>
      <ShopItemGrid
        items={shop.featured}
        cols={{ base: 1, xs: 2, sm: 4 }}
        ownedCosmeticIds={ownedCosmeticIds}
      />
    </Paper>
  );
}
