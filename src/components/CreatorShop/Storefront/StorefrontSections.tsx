import { Stack } from '@mantine/core';
import { Fragment, useMemo } from 'react';
import type { CreatorShopData } from '~/components/CreatorShop/creator-shop.util';
import { CosmeticsSection } from '~/components/CreatorShop/Storefront/CosmeticsSection';
import { FeaturedSection } from '~/components/CreatorShop/Storefront/FeaturedSection';
import { MerchSection } from '~/components/CreatorShop/Storefront/MerchSection';
import { ModelsSection } from '~/components/CreatorShop/Storefront/ModelsSection';
import { ResoldSection } from '~/components/CreatorShop/Storefront/ResoldSection';
import type { CreatorShopSectionKey } from '~/server/schema/creator-shop.schema';
import { creatorShopSectionKeys } from '~/server/schema/creator-shop.schema';

// Registry keyed by `CreatorShopSectionKey`: adding a section is a localized
// change — build its element here and add its key to the schema. Each section
// component decides its own visibility (returns null when it shouldn't show).
export function StorefrontSections({
  shop,
  ownedCosmeticIds,
  displayName,
  username,
  ownerUserId,
  baseUrl,
}: {
  shop: CreatorShopData;
  ownedCosmeticIds: Set<number>;
  displayName: string;
  username: string;
  ownerUserId: number;
  baseUrl: string;
}) {
  const sectionOrder = useMemo<CreatorShopSectionKey[]>(() => {
    const configured = shop.settings.sections;
    if (configured && configured.length)
      return configured.filter((s) => s.visible).map((s) => s.key);
    return [...creatorShopSectionKeys];
  }, [shop.settings.sections]);

  const sections: Record<CreatorShopSectionKey, React.ReactNode> = {
    featured: (
      <FeaturedSection shop={shop} displayName={displayName} ownedCosmeticIds={ownedCosmeticIds} />
    ),
    cosmetics: <CosmeticsSection items={shop.cosmetics} ownedCosmeticIds={ownedCosmeticIds} />,
    resold: (
      <ResoldSection
        items={shop.resold}
        ownedCosmeticIds={ownedCosmeticIds}
        viaShopUserId={ownerUserId}
      />
    ),
    merch: <MerchSection />,
    models: <ModelsSection shop={shop} displayName={displayName} username={username} />,
  };

  return (
    <Stack gap="xl">
      {sectionOrder.map((key) => (
        <Fragment key={key}>{sections[key]}</Fragment>
      ))}
    </Stack>
  );
}
