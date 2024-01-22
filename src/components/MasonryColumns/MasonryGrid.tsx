import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import { createStyles } from '@mantine/core';
import React, { useMemo } from 'react';
import { useMasonryContainerContext } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryRenderItemProps } from '~/components/MasonryColumns/masonry.types';

type Props<TData> = {
  data: TData[];
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  itemId?: (data: TData) => string | number;
  empty?: React.ReactNode;
  maxRows?: number;
};

export function MasonryGrid<TData>({
  data,
  render: RenderComponent,
  itemId,
  empty = null,
  maxRows,
}: Props<TData>) {
  const { columnCount, columnWidth, columnGap, rowGap, maxSingleColumnWidth } =
    useMasonryContainerContext();

  const { classes } = useStyles({
    columnCount,
    columnWidth,
    columnGap,
    rowGap,
    maxSingleColumnWidth,
  });

  const items = useMemo(() => {
    if (!maxRows) return data;
    const wholeRows = Math.floor(data.length / columnCount);
    const rows = maxRows > wholeRows ? wholeRows : maxRows;
    if (rows < 1) return data;
    return data.slice(0, rows * columnCount);
  }, [columnCount, data, maxRows]);

  return items.length ? (
    <div className={classes.grid}>
      {items.map((item, index) => {
        const key = itemId?.(item) ?? index;
        return (
          <React.Fragment key={key}>
            {/* <RenderComponent index={index} data={item} width={columnWidth} height={columnWidth} /> */}
            {createRenderElement(RenderComponent, index, item, columnWidth)}
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
  ) => ({
    empty: { height: columnWidth },
    grid: {
      display: 'grid',
      gridTemplateColumns:
        columnCount === 1
          ? `minmax(${columnWidth}px, ${maxSingleColumnWidth}px)`
          : `repeat(${columnCount}, ${columnWidth}px)`,
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
