import { createStyles } from '@mantine/core';
import React, { Fragment, useMemo, useRef } from 'react';
import {
  useColumnCount,
  useContainerWidth,
  useMasonryColumns,
} from '~/components/MasonryColumns/masonryColumns.utils';

interface RenderComponentProps<Item> {
  /**
   * The index of the cell in the `items` prop array.
   */
  index: number;
  /**
   * The rendered width of the cell's column.
   */
  width: number;
  /**
   * The data at `items[index]` of your `items` prop array.
   */
  height: number;
  data: Item;
}

// TODO.Briant - max height of item to limit height of masonry items
type LayoutProps = {
  // width: number;
  columnWidth: number;
  columnCount?: number;
  maxColumnCount?: number;
  maxItemHeight?: number;
  gap?: number;
  columnGap?: number;
  rowGap?: number;
};

type MasonryColumnsProps<TData> = LayoutProps & {
  data: TData[];
  pick: (data: TData) => { height: number; width: number };
  render: React.ComponentType<RenderComponentProps<TData>>;
};

export function MasonryColumns<TData>({
  data,
  pick,
  render,
  // width,
  columnWidth,
  columnCount,
  maxColumnCount,
  gap = 16,
  columnGap = gap,
  rowGap = gap,
}: MasonryColumnsProps<TData>) {
  const containerRef = useRef(null);
  const width = useContainerWidth(containerRef);
  const colCount = useColumnCount(width, columnWidth, columnGap, columnCount, maxColumnCount);
  const { classes } = useStyles({ columnCount: colCount, columnWidth, columnGap, rowGap });

  const columns = useMasonryColumns(data, columnWidth, colCount, pick);
  const RenderComponent = render;

  return (
    <div ref={containerRef} className={classes.columns}>
      {width !== 0 &&
        columns.map((items, colIndex) => (
          <div key={colIndex} className={classes.column}>
            {items.map(({ height, data }, index) => (
              <Fragment key={index}>
                {/* <pre style={{ overflow: 'hidden' }}>{JSON.stringify(data)}</pre> */}
                {/* {render({ data, index, width: columnWidth })} */}
                <RenderComponent data={data} index={index} width={columnWidth} height={height} />
              </Fragment>
            ))}
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
    }: { columnCount: number; columnWidth: number; columnGap: number; rowGap: number }
  ) => ({
    columns: {
      display: 'flex',
      columnGap,
      justifyContent: 'center',
    },
    column: {
      display: 'flex',
      flexDirection: 'column',
      width: columnCount === 1 ? '100%' : columnWidth,
      rowGap,
    },
  })
);
