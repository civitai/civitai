import { Button, Text } from '@mantine/core';
import { IconArrowRight, IconShoppingBag } from '@tabler/icons-react';
import React, { useState } from 'react';
import { useQueryWishlistedShopItems } from '~/components/CosmeticShop/cosmetic-shop.util';
import { useQueryCreatorShop } from '~/components/CreatorShop/creator-shop.util';
import { useOwnedCosmeticIds } from '~/components/CreatorShop/Storefront/storefront.util';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { ProfileSection, ProfileSectionPreview } from '~/components/Profile/ProfileSection';
import classes from '~/components/Profile/ProfileSection.module.css';
import { ShopItem } from '~/components/Shop/ShopItem';
import { getShopRowColumns, pickShopRowItems } from './shop-section.utils';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { CreatorShopItem } from '~/components/CreatorShop/creator-shop.util';
import type { CosmeticShopItemGetById } from '~/types/router';

// Mounted only once the grid exists: useResizeObserver attaches on mount, so the grid
// can't live in the parent, which renders before it is in view.
export const ShopRow = ({
  featured,
  cosmetics,
}: {
  featured: CreatorShopItem[];
  cosmetics: CreatorShopItem[];
}) => {
  const ownedCosmeticIds = useOwnedCosmeticIds();
  const { wishlistedIds } = useQueryWishlistedShopItems();
  const [columns, setColumns] = useState(1);
  const gridRef = useResizeObserver<HTMLDivElement>((entry) => {
    setColumns(getShopRowColumns(entry.contentRect.width));
  });
  const items = pickShopRowItems({ featured, cosmetics, columns });

  // Same card margins as ShowcaseGrid, but its fixed-row clipping crops ShopItem's
  // height:100% cards, so the row is sized by column count instead.
  return (
    <div
      ref={gridRef}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        marginTop: -8,
      }}
    >
      {items.map((item) => (
        <div key={item.id} style={{ margin: 8 }}>
          <ShopItem
            item={item as unknown as CosmeticShopItemGetById}
            sectionItemCreatedAt={item.createdAt}
            alreadyOwned={item.cosmeticId != null && ownedCosmeticIds.has(item.cosmeticId)}
            wishlisted={wishlistedIds.has(item.id)}
            creator={item.cosmetic?.creator ?? item.addedBy}
          />
        </div>
      ))}
    </div>
  );
};

// Profile-overview section that showcases the creator's featured shop items so
// visitors can jump straight into their shop. Renders one row: featured items first,
// topped up from the creator's other cosmetics. Renders nothing unless the shop is
// enabled and has something to sell. `shop.cosmetics` is already buyer-visible
// (published, listed, in its availability window) for every viewer, owner included,
// so pending items never reach this list.
export const ShopSection = ({ user }: ProfileSectionProps) => {
  const features = useFeatureFlags();
  const [ref, inView] = useInViewDynamic({ id: 'profile-shop-section' });
  const { shop, isLoading } = useQueryCreatorShop(features.creatorShop ? user.id : undefined);

  if (!features.creatorShop) return null;

  const hasItems =
    shop?.settings.enabled === true && (shop.featured.length > 0 || shop.cosmetics.length > 0);
  if (!isLoading && !hasItems) return null;

  return (
    <div ref={ref} className={classes.profileSection}>
      {inView &&
        (isLoading ? (
          <ProfileSectionPreview />
        ) : (
          <ProfileSection
            title="Shop"
            icon={<IconShoppingBag />}
            action={
              <Link legacyBehavior href={`/user/${user.username}/shop`} passHref>
                <Button
                  h={34}
                  component="a"
                  variant="subtle"
                  rightSection={<IconArrowRight size={16} />}
                >
                  <Text inherit>Visit shop</Text>
                </Button>
              </Link>
            }
          >
            {shop && hasItems && <ShopRow featured={shop.featured} cosmetics={shop.cosmetics} />}
          </ProfileSection>
        ))}
    </div>
  );
};
