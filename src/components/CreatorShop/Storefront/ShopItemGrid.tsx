import type { SimpleGridProps } from '@mantine/core';
import { SimpleGrid } from '@mantine/core';
import type { CreatorShopItem } from '~/components/CreatorShop/creator-shop.util';
import { ShopItem } from '~/components/Shop/ShopItem';
import type { CosmeticShopItemGetById } from '~/types/router';

// Both the Featured and Cosmetics sections render the same card; they differ
// only in their data and column layout. The cast bridges the storefront's item
// shape to `ShopItem`'s prop type (see the note in shop.tsx about phantom
// generated-type errors — keep the cast, `pnpm run typecheck` is the truth).
export function ShopItemGrid({
  items,
  cols,
  ownedCosmeticIds,
}: {
  items: CreatorShopItem[];
  cols: SimpleGridProps['cols'];
  ownedCosmeticIds: Set<number>;
}) {
  return (
    <SimpleGrid cols={cols} spacing="md">
      {items.map((item) => (
        <ShopItem
          key={item.id}
          item={item as unknown as CosmeticShopItemGetById}
          sectionItemCreatedAt={item.createdAt}
          alreadyOwned={ownedCosmeticIds.has(item.cosmeticId)}
        />
      ))}
    </SimpleGrid>
  );
}
