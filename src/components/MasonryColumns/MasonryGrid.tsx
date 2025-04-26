import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import { Button, useMantineTheme } from '@mantine/core';
import React, { useMemo } from 'react';
import { MasonryRenderItemProps } from '~/components/MasonryColumns/masonry.types';
import { useCreateAdFeed } from '~/components/Ads/ads.utils';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';
import { Text } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconCaretRightFilled } from '@tabler/icons-react';
import Image from 'next/image';
import { AdUnitIncontent_1 } from '~/components/Ads/AdUnit';
import { TwCard } from '~/components/TwCard/TwCard';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { AdUnitRenderable } from '~/components/Ads/AdUnitRenderable';
import classes from './MasonryGrid.module.scss';

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

  const { adsEnabled } = useAdsContext();
  const browsingLevel = useBrowsingLevelDebounced();
  const adsReallyAreEnabled = adsEnabled && getIsSafeBrowsingLevel(browsingLevel) && withAds;
  const createAdFeed = useCreateAdFeed();
  const items = useMemo(
    () =>
      createAdFeed({
        data,
        columnCount,
        options: [
          {
            width: 300,
            height: 250,
            AdUnit: AdUnitIncontent_1,
          },
        ],
      }),
    [columnCount, data, adsReallyAreEnabled]
  );

  return items.length ? (
    <div
      className={classes.grid}
      style={
        {
          gridTemplateColumns:
            columnCount === 1
              ? `minmax(${columnWidth}px, ${maxSingleColumnWidth}px)`
              : `repeat(${columnCount}, ${columnWidth}px)`,
          '--column-gap': `${columnGap}px`,
          '--row-gap': `${rowGap}px`,
          '--column-width': `${columnWidth}px`,
        } as React.CSSProperties
      }
    >
      {items.map((item, index) => {
        const key = item.type === 'data' ? itemId?.(item.data) ?? index : `ad_${index}`;

        return item.type === 'data' ? (
          <RenderComponent
            key={key}
            index={index}
            data={item.data}
            width={columnWidth}
            height={columnWidth}
          />
        ) : (
          <AdUnitRenderable key={key}>
            <TwCard className="mx-auto min-w-80 justify-between gap-2 border p-2 shadow">
              <div className="flex flex-col items-center  gap-2">
                <Image
                  src={`/images/logo_${theme.colorScheme}_mode.png`}
                  alt="Civitai logo"
                  height={30}
                  width={142}
                />
                <Text>Become a Member to turn off ads today.</Text>
                <Button
                  component={Link}
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
              <div>
                <item.data.AdUnit />
              </div>
            </TwCard>
          </AdUnitRenderable>
        );
      })}
    </div>
  ) : (
    <div className={classes.empty}>{empty}</div>
  );
}

const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap, OneKeyMap, OneKeyMap],
  (RenderComponent, index, data, columnWidth) => (
    <RenderComponent index={index} data={data} width={columnWidth} height={columnWidth} />
  )
);

