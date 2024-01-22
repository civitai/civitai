import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import { createStyles } from '@mantine/core';
import React from 'react';
import { useMasonryColumns } from '~/components/MasonryColumns/masonry.utils';
import { useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';
import {
  MasonryRenderItemProps,
  MasonryAdjustHeightFn,
  MasonryImageDimensionsFn,
} from '~/components/MasonryColumns/masonry.types';
import { AscendeumAd } from '~/components/Ads/AscendeumAds/AscendeumAd';

type Props<TData> = {
  data: TData[];
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  imageDimensions: MasonryImageDimensionsFn<TData>;
  adjustHeight?: MasonryAdjustHeightFn<TData>;
  maxItemHeight?: number;
  itemId?: (data: TData) => string | number;
  staticItem?: (props: { columnWidth: number; height: number }) => React.ReactNode;
  /** [lowerInterval, upperInterval] */
  adInterval?: number[];
};

export function MasonryColumns<TData>({
  data,
  render: RenderComponent,
  imageDimensions,
  adjustHeight,
  maxItemHeight,
  itemId,
  staticItem,
  adInterval,
}: Props<TData>) {
  const { columnCount, columnWidth, columnGap, rowGap, maxSingleColumnWidth } = useMasonryContext();

  const { classes } = useStyles({
    columnCount,
    columnWidth,
    columnGap,
    rowGap,
    maxSingleColumnWidth,
  });

  const columns = useMasonryColumns(
    data,
    columnWidth,
    columnCount,
    imageDimensions,
    adjustHeight,
    maxItemHeight,
    adInterval
  );

  return (
    <div className={classes.columns}>
      {columns.map((items, colIndex) => (
        <div key={colIndex} className={classes.column}>
          {items.map(({ height, data }, index) => {
            const key = data.type === 'data' ? itemId?.(data.data) ?? index : index;
            const showStaticItem = colIndex === 0 && index === 0 && staticItem;

            return (
              <React.Fragment key={key}>
                {showStaticItem && staticItem({ columnWidth, height: 450 })}
                {data.type === 'data' &&
                  createRenderElement(RenderComponent, index, data.data, columnWidth, height)}
                {data.type === 'ad' && (
                  <AscendeumAd
                    adunit="Dynamic_InContent"
                    sizes={{ [0]: '300x250' }}
                    style={{ margin: '0 auto' }}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const useStyles = createStyles(
  (
    theme,
    {
      columnCount,
      columnWidth,
      columnGap,
      rowGap,
      maxSingleColumnWidth,
    }: {
      columnCount: number;
      columnWidth: number;
      columnGap: number;
      rowGap: number;
      maxSingleColumnWidth?: number;
    }
  ) => {
    return {
      columns: {
        display: 'flex',
        columnGap,
        justifyContent: 'center',
        margin: '0 auto',
      },
      column: {
        display: 'flex',
        flexDirection: 'column',
        width: columnCount === 1 ? '100%' : columnWidth,
        maxWidth: maxSingleColumnWidth,
        rowGap,
      },
    };
  }
);

// supposedly ~5.5x faster than createElement without the memo
const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap, OneKeyMap, OneKeyMap],
  (RenderComponent, index, data, columnWidth, columnHeight) => (
    <RenderComponent index={index} data={data} width={columnWidth} height={columnHeight} />
  )
);
