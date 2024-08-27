import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import { Button, Stack, createStyles, useMantineTheme } from '@mantine/core';
import React, { useMemo } from 'react';
import { MasonryRenderItemProps } from '~/components/MasonryColumns/masonry.types';
import { createAdFeed } from '~/components/Ads/ads.utils';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';
import { Text } from '@mantine/core';

import { NextLink } from '@mantine/next';
import { IconCaretRightFilled } from '@tabler/icons-react';
import Image from 'next/image';
import { DynamicAd } from '~/components/Ads/AdUnit';
import { TwCard } from '~/components/TwCard/TwCard';

type Props<TData> = {
  data: TData[];
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  itemId?: (data: TData) => string | number;
  empty?: React.ReactNode;
  withAds?: boolean;
};

export function MasonryGrid<TData>({
  data,
  render: RenderComponent,
  itemId,
  empty = null,
  withAds,
}: Props<TData>) {
  const theme = useMantineTheme();
  const { columnCount, columnWidth, columnGap, rowGap, maxSingleColumnWidth } = useMasonryContext();

  const { classes } = useStyles({
    columnWidth,
    columnGap,
    rowGap,
  });

  const { adsEnabled } = useAdsContext();
  const items = useMemo(
    () => createAdFeed({ data, columnCount, showAds: adsEnabled && withAds }),
    [columnCount, data, adsEnabled, withAds]
  );

  return items.length ? (
    <div
      className={classes.grid}
      style={{
        gridTemplateColumns:
          columnCount === 1
            ? `minmax(${columnWidth}px, ${maxSingleColumnWidth}px)`
            : `repeat(${columnCount}, ${columnWidth}px)`,
      }}
    >
      {items.map((item, index) => {
        const key = item.type === 'data' ? itemId?.(item.data) ?? index : `ad_${index}`;
        return (
          <React.Fragment key={key}>
            {item.type === 'data' &&
              createRenderElement(RenderComponent, index, item.data, columnWidth)}
            {item.type === 'ad' && (
              <TwCard className="border p-2 shadow">
                <div className="mb-auto flex flex-col items-center gap-2">
                  <Image
                    src={`/images/logo_${theme.colorScheme}_mode.png`}
                    alt="Civitai logo"
                    height={30}
                    width={142}
                  />
                  <Text>Become a Member to turn off ads today.</Text>
                  <Button
                    component={NextLink}
                    href="/pricing"
                    compact
                    color="green"
                    variant="outline"
                    className="w-24"
                  >
                    <Text weight={500}>Do It</Text>
                    <IconCaretRightFilled size={16} />
                  </Button>
                </div>

                <DynamicAd />
              </TwCard>
            )}
          </React.Fragment>
        );
      })}
    </div>
  ) : (
    <div className={classes.empty}>{empty}</div>
  );
}

const useStyles = createStyles(
  (
    theme,
    {
      columnWidth,
      columnGap,
      rowGap,
    }: {
      columnWidth: number;
      columnGap: number;
      rowGap: number;
    }
  ) => ({
    empty: { height: columnWidth },
    grid: {
      display: 'grid',

      columnGap,
      rowGap,
      justifyContent: 'center',
    },
  })
);

const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap, OneKeyMap, OneKeyMap],
  (RenderComponent, index, data, columnWidth) => (
    <RenderComponent index={index} data={data} width={columnWidth} height={columnWidth} />
  )
);
