import { Button, Paper, Stack, Text } from '@mantine/core';
import { IconArrowRight, IconShoppingBag } from '@tabler/icons-react';
import React, { useState } from 'react';
import { useQueryWishlistedShopItems } from '~/components/CosmeticShop/cosmetic-shop.util';
import { useQueryCreatorShop } from '~/components/CreatorShop/creator-shop.util';
import {
  serviceTermsLine,
  useQueryShopServices,
} from '~/components/CreatorShop/Services/creator-service.util';
import type { ServiceOffering } from '~/components/CreatorShop/Services/creator-service.util';
import { storefrontSectionId, storefrontSectionKeys } from '~/components/CreatorShop/section-meta';
import { useOwnedCosmeticIds } from '~/components/CreatorShop/Storefront/storefront.util';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { ProfileSection, ProfileSectionPreview } from '~/components/Profile/ProfileSection';
import classes from '~/components/Profile/ProfileSection.module.css';
import { ShopItem } from '~/components/Shop/ShopItem';
import { getShopRowColumns, pickShopRowItems, shopSectionHasItems } from './shop-section.utils';
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

export const ServicesRow = ({
  offerings,
  href,
}: {
  offerings: Pick<ServiceOffering, 'id' | 'title' | 'deliveryDays' | 'revisionsIncluded'>[];
  href: string;
}) => (
  <Stack gap="xs">
    {offerings.map((offering) => (
      <Paper
        key={offering.id}
        component={Link}
        href={href}
        withBorder
        radius="md"
        p="sm"
        style={{ color: 'inherit', textDecoration: 'none' }}
      >
        <Text fw={600} lineClamp={1}>
          {offering.title}
        </Text>
        <Text size="sm" c="dimmed">
          {serviceTermsLine(offering)}
        </Text>
      </Paper>
    ))}
  </Stack>
);

// Profile-overview section that showcases the creator's featured shop items so
// visitors can jump straight into their shop. Renders one row: featured items first,
// topped up from the creator's other cosmetics, then the seller's Active services (linking
// to the storefront's Services section). Renders nothing unless the shop is enabled and has
// something to sell. `shop.cosmetics` is already buyer-visible
// (published, listed, in its availability window) for every viewer, owner included,
// so pending items never reach this list.
export const ShopSection = ({ user }: ProfileSectionProps) => {
  const features = useFeatureFlags();
  const [ref, inView] = useInViewDynamic({ id: 'profile-shop-section' });
  const { shop, isLoading } = useQueryCreatorShop(features.creatorShop ? user.id : undefined);

  const { offerings, isLoading: servicesLoading } = useQueryShopServices(
    user.id,
    !!features.creatorShop && !!features.creatorServices
  );

  if (!features.creatorShop) return null;

  const servicesShown =
    !!shop && storefrontSectionKeys(shop.settings.sections, features).includes('services');
  const hasItems = shopSectionHasItems({
    enabled: shop?.settings.enabled === true,
    cosmeticCount: (shop?.featured.length ?? 0) + (shop?.cosmetics.length ?? 0),
    activeServiceCount: offerings.length,
    servicesShown,
  });
  const loading = isLoading || (!!features.creatorServices && servicesLoading);
  if (!loading && !hasItems) return null;
  const hasCosmetics = !!shop && shop.featured.length + shop.cosmetics.length > 0;
  const showServices = servicesShown && offerings.length > 0;

  return (
    <div ref={ref} className={classes.profileSection}>
      {inView &&
        (loading ? (
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
            <Stack gap="md">
              {shop && hasCosmetics && (
                <ShopRow featured={shop.featured} cosmetics={shop.cosmetics} />
              )}
              {showServices && (
                <ServicesRow
                  offerings={offerings}
                  href={`/user/${user.username}/shop#${storefrontSectionId('services')}`}
                />
              )}
            </Stack>
          </ProfileSection>
        ))}
    </div>
  );
};
