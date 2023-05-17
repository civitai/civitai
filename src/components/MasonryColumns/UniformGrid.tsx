import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import { createStyles } from '@mantine/core';
import React from 'react';
import { useMasonryContainerContext } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryRenderItemProps } from '~/components/MasonryColumns/masonry.types';

type Props<TData> = {
  data: TData[];
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  itemId?: (data: TData) => string | number;
  empty?: React.ReactNode;
};

export function UniformGrid<TData>({
  data,
  render: RenderComponent,
  itemId,
  empty = null,
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

  return data.length ? (
    <div className={classes.grid}>
      {data.map((item, index) => {
        const key = itemId?.(item) ?? index;
        return (
          <div key={key} id={key.toString()}>
            {createRenderElement(RenderComponent, index, item, columnWidth)}
          </div>
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
      display: 'flex',
      flexDirection: 'row',
      flexWrap: 'wrap',
      minHeight: columnWidth,
      columnGap,
      rowGap,

      '& > div': {
        width: columnCount === 1 ? '100%' : columnWidth,
        maxWidth: maxSingleColumnWidth,
        height: columnCount === 1 ? '100%' : columnWidth,
        maxHeight: maxSingleColumnWidth,
      },
    },
  })
);

const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap, OneKeyMap, OneKeyMap],
  (RenderComponent, index, data, columnWidth) => (
    <RenderComponent index={index} data={data} width={columnWidth} height={columnWidth} />
  )
);

// UniformGrid.Item = function UniformGridItem({ children }: { children: React.ReactNode }) {
//   return <></>;
// };
