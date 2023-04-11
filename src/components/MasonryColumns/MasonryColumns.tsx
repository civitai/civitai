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
import { useMasonryContainerContext } from '~/components/MasonryColumns/MasonryContainer';

type Props<TData> = {
  data: TData[];
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  imageDimensions: MasonryImageDimensionsFn<TData>;
  adjustHeight?: MasonryAdjustHeightFn;
  maxItemHeight?: number;
  itemId?: (data: TData) => string | number;
};

export function MasonryColumns<TData>({
  data,
  render: RenderComponent,
  imageDimensions,
  adjustHeight,
  maxItemHeight,
  itemId,
}: Props<TData>) {
  const { columnWidth, columnGap, rowGap, maxSingleColumnWidth } = useMasonryContext();
  const { columnCount } = useMasonryContainerContext();

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
    maxItemHeight
  );

  return (
    <div className={classes.columns}>
      {columns.map((items, colIndex) => (
        <div key={colIndex} className={classes.column}>
          {items.map(({ height, data }, index) => {
            const key = itemId?.(data) ?? index;
            return (
              <div key={key} id={key.toString()}>
                {createRenderElement(RenderComponent, index, data, columnWidth, height)}
              </div>
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

function defaultGetItemKey<TData>(_: TData, i: number) {
  return i;
}
