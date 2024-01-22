import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import { createStyles } from '@mantine/core';
import React, { useMemo } from 'react';
import { MasonryRenderItemProps } from '~/components/MasonryColumns/masonry.types';
import { createAdFeed } from '~/components/Ads/ads.utils';
import { useAscendeumAdsContext } from '~/components/Ads/AscendeumAds/AscendeumAdsProvider';
import { AscendeumAd } from '~/components/Ads/AscendeumAds/AscendeumAd';
import { useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';

type Props<TData> = {
  data: TData[];
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  itemId?: (data: TData) => string | number;
  empty?: React.ReactNode;
  adInterval?: number[];
};

export function MasonryGrid<TData>({
  data,
  render: RenderComponent,
  itemId,
  empty = null,
  adInterval,
}: Props<TData>) {
  const { columnCount, columnWidth, columnGap, rowGap, maxSingleColumnWidth } = useMasonryContext();

  const { classes } = useStyles({
    columnWidth,
    columnGap,
    rowGap,
  });

  const { adsBlocked } = useAscendeumAdsContext();
  const items = useMemo(
    () => createAdFeed({ data, interval: adInterval, adsBlocked }),
    [columnCount, data]
  );

  console.log({
    gridTemplateColumns:
      columnCount === 1
        ? `minmax(${columnWidth}px, ${maxSingleColumnWidth}px)`
        : `repeat(${columnCount}, ${columnWidth}px)`,
  });

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
              <AscendeumAd
                adunit="Dynamic_InContent"
                sizes={{ [0]: '300x250' }}
                style={{ margin: 'auto auto' }}
              />
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
