import type { CreatorShopItem } from '~/components/CreatorShop/creator-shop.util';
import { ShopItem } from '~/components/Shop/ShopItem';
import type { CosmeticShopItemGetById } from '~/types/router';

// Both the Featured and Cosmetics sections render the same card; they differ
// only in their data. The cast bridges the storefront's item shape to
// `ShopItem`'s prop type (see the note in shop.tsx about phantom generated-type
// errors — keep the cast, `pnpm run typecheck` is the truth).
//
// The grid auto-fills columns from a min card width, so the number of items per
// row flexes with the container and cards keep a consistent size at any screen.
export function ShopItemGrid({
  items,
  ownedCosmeticIds,
  ownerUserId,
  viaShopUserId,
}: {
  items: CreatorShopItem[];
  ownedCosmeticIds: Set<number>;
  // The shop owner whose page this is. Attribution is hidden for their own
  // items (a given) and shown for resold items from other creators.
  ownerUserId: number;
  // When set, purchases are attributed to this shop owner (cross-creator resale).
  viaShopUserId?: number;
}) {
  return (
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
      {items.map((item) => {
        const creator = item.cosmetic.creator;
        return (
          <ShopItem
            key={item.id}
            layout="storefront"
            item={item as unknown as CosmeticShopItemGetById}
            sectionItemCreatedAt={item.createdAt}
            alreadyOwned={ownedCosmeticIds.has(item.cosmeticId)}
            viaShopUserId={viaShopUserId}
            creator={creator?.id === ownerUserId ? null : creator}
          />
        );
      })}
    </div>
  );
}
