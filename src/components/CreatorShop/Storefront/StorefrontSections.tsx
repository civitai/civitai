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
  username,
  ownerUserId,
  preview = false,
}: {
  shop: CreatorShopData;
  ownedCosmeticIds: Set<number>;
  username: string;
  ownerUserId: number;
  preview?: boolean;
}) {
  const sectionOrder = useMemo<CreatorShopSectionKey[]>(() => {
    const configured = shop.settings.sections;
    if (configured && configured.length)
      return configured.filter((s) => s.visible).map((s) => s.key);
    return [...creatorShopSectionKeys];
  }, [shop.settings.sections]);

  const sections: Record<CreatorShopSectionKey, React.ReactNode> = {
    featured: (
      <FeaturedSection shop={shop} ownedCosmeticIds={ownedCosmeticIds} ownerUserId={ownerUserId} />
    ),
    cosmetics: (
      <CosmeticsSection
        items={shop.cosmetics}
        ownedCosmeticIds={ownedCosmeticIds}
        ownerUserId={ownerUserId}
      />
    ),
    resold: (
      <ResoldSection
        items={shop.resold}
        ownedCosmeticIds={ownedCosmeticIds}
        viaShopUserId={ownerUserId}
      />
    ),
    merch: <MerchSection />,
    models: <ModelsSection shop={shop} username={username} preview={preview} />,
  };

  return (
    <Stack gap="xl">
      {sectionOrder.map((key) => (
        <Fragment key={key}>
          {/* Featured renders its own full-bleed band; every other section is
              constrained to the shared max width and centered. */}
          {key === 'featured' ? (
            sections[key]
          ) : (
            <div className="mx-auto w-full max-w-[1600px]">{sections[key]}</div>
          )}
        </Fragment>
      ))}
    </Stack>
  );
}
