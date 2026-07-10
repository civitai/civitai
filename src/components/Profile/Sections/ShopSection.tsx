import { Button, Text } from '@mantine/core';
import { IconArrowRight, IconShoppingBag } from '@tabler/icons-react';
import React from 'react';
import { useQueryCreatorShop } from '~/components/CreatorShop/creator-shop.util';
import { useOwnedCosmeticIds } from '~/components/CreatorShop/Storefront/storefront.util';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { ProfileSection, ProfileSectionPreview } from '~/components/Profile/ProfileSection';
import classes from '~/components/Profile/ProfileSection.module.css';
import { ShopItem } from '~/components/Shop/ShopItem';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { CosmeticShopItemGetById } from '~/types/router';

// Profile-overview section that showcases the creator's featured shop items so
// visitors can jump straight into their shop. Renders nothing unless the shop is
// published and has featured items.
export const ShopSection = ({ user }: ProfileSectionProps) => {
  const features = useFeatureFlags();
  const [ref, inView] = useInViewDynamic({ id: 'profile-shop-section' });
  const { shop, isLoading } = useQueryCreatorShop(features.creatorShop ? user.id : undefined);
  const ownedCosmeticIds = useOwnedCosmeticIds();

  if (!features.creatorShop) return null;

  const featured = shop?.settings.enabled === true ? shop.featured : [];
  if (!isLoading && featured.length === 0) return null;

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
            {/* Mirrors ShowcaseGrid's column/margin rhythm (so cards line up with
                neighbouring sections) but without its fixed-row clipping, which
                crops ShopItem's height:100% cards. */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                marginTop: -8,
              }}
            >
              {featured.map((item) => (
                <div key={item.id} style={{ margin: 8 }}>
                  <ShopItem
                    item={item as unknown as CosmeticShopItemGetById}
                    sectionItemCreatedAt={item.createdAt}
                    alreadyOwned={ownedCosmeticIds.has(item.cosmeticId)}
                    creator={item.cosmetic.creator}
                  />
                </div>
              ))}
            </div>
          </ProfileSection>
        ))}
    </div>
  );
};
