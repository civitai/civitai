import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import React, { useMemo } from 'react';
import { MasonryRenderItemProps } from '~/components/MasonryColumns/masonry.types';
import { useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';
import classes from './UniformGrid.module.scss';

type Props<TData> = {
  data: TData[];
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  itemId?: (data: TData) => string | number;
  empty?: React.ReactNode;
  maxRows?: number;
};

export function UniformGrid<TData>({
  data,
  render: RenderComponent,
  itemId,
  empty = null,
  maxRows,
}: Props<TData>) {
  const { columnCount, columnWidth, columnGap, rowGap, maxSingleColumnWidth } = useMasonryContext();

  const items = useMemo(() => {
    if (!maxRows) return data;
    const wholeRows = Math.floor(data.length / columnCount);
    const rows = maxRows > wholeRows ? wholeRows : maxRows;
    if (rows < 1) return data;
    return data.slice(0, rows * columnCount);
  }, [columnCount, data, maxRows]);

  return items.length ? (
    <div
      className={classes.grid}
      style={
        {
          '--column-width': `${columnWidth}px`,
          '--column-gap': `${columnGap}px`,
          '--row-gap': `${rowGap}px`,
          '--grid-item-width': columnCount === 1 ? '100%' : `${columnWidth}px`,
          '--max-single-column-width': maxSingleColumnWidth ? `${maxSingleColumnWidth}px` : 'none',
        } as React.CSSProperties
      }
    >
      {items.map((item, index) => {
        const key = itemId?.(item) ?? index;
        return (
          <div key={key} id={key.toString()}>
            <div className={classes.gridItem}>
              {createRenderElement(RenderComponent, index, item, columnWidth)}
            </div>
          </div>
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

// UniformGrid.Item = function UniformGridItem({ children }: { children: React.ReactNode }) {
//   return <></>;
// };

