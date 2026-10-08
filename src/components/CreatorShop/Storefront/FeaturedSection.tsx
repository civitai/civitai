import { Stack } from '@mantine/core';
import clsx from 'clsx';
import { SECTION_GLOWS } from '~/components/Challenge/DynamicPrizeCard/constants';
import type { CreatorShopData } from '~/components/CreatorShop/creator-shop.util';
import { sectionIcons } from '~/components/CreatorShop/section-meta';
import { SectionHeader } from '~/components/CreatorShop/Storefront/SectionHeader';
import { ShopItemGrid } from '~/components/CreatorShop/Storefront/ShopItemGrid';
import {
  SpotlightDivider,
  SpotlightGlow,
  SpotlightSurface,
} from '~/components/SpotlightCard/SpotlightBorderCard';
import classes from './FeaturedSection.module.scss';

export function FeaturedSection({
  shop,
  ownedCosmeticIds,
  ownerUserId,
}: {
  shop: CreatorShopData;
  ownedCosmeticIds: Set<number>;
  ownerUserId: number;
}) {
  if (shop.featured.length === 0) return null;

  // Full-bleed tinted band: the `-mx-3` breaks out of the page gutter so the
  // background spans the whole section, while the inner wrapper re-aligns the
  // content to the same width as the other (constrained) sections.
  return (
    <SpotlightSurface className={clsx(classes.band, '-mx-3 px-3 py-8')}>
      <SpotlightDivider overlay color={SECTION_GLOWS.yellow} size={200} />
      <SpotlightGlow color="rgba(250,176,5,0.1)" size={500} fade={60} />
      <div className={clsx(classes.content, 'mx-auto w-full max-w-[1600px]')}>
        <Stack gap="md">
          <SectionHeader icon={sectionIcons.featured} title="Featured" />
          <ShopItemGrid
            items={shop.featured}
            ownedCosmeticIds={ownedCosmeticIds}
            ownerUserId={ownerUserId}
            // Attribute purchases to this storefront — unattributed purchases of
            // sellable items pay the platform the reseller share.
            viaShopUserId={ownerUserId}
          />
        </Stack>
      </div>
    </SpotlightSurface>
  );
}
