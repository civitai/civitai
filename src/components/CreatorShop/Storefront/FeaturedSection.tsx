import { Stack } from '@mantine/core';
import clsx from 'clsx';
import type { CSSProperties } from 'react';
import { useCallback, useState } from 'react';
import { GlowDivider } from '~/components/Challenge/DynamicPrizeCard/GlowDivider';
import type { CreatorShopData } from '~/components/CreatorShop/creator-shop.util';
import { sectionIcons } from '~/components/CreatorShop/section-meta';
import { SectionHeader } from '~/components/CreatorShop/Storefront/SectionHeader';
import { ShopItemGrid } from '~/components/CreatorShop/Storefront/ShopItemGrid';
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
  const [spotlight, setSpotlight] = useState({ x: 0, y: 0, opacity: 0 });
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setSpotlight({ x: e.clientX - rect.left, y: e.clientY - rect.top, opacity: 1 });
  }, []);
  const handleMouseLeave = useCallback(() => setSpotlight((s) => ({ ...s, opacity: 0 })), []);

  if (shop.featured.length === 0) return null;

  // Full-bleed tinted band: the `-mx-3` breaks out of the page gutter so the
  // background spans the whole section, while the inner wrapper re-aligns the
  // content to the same width as the other (constrained) sections.
  return (
    <div
      className={clsx(classes.band, '-mx-3 px-3 py-8')}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={
        {
          '--spotlight-x': `${spotlight.x}px`,
          '--spotlight-y': `${spotlight.y}px`,
          '--spotlight-opacity': spotlight.opacity,
        } as CSSProperties
      }
    >
      <GlowDivider variant="yellow" />
      <div className={classes.bloom} />
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
    </div>
  );
}
