import { useWindowEvent } from '@mantine/hooks';
import { useLayoutEffect, useMemo, useState } from 'react';

// don't know if I need memoized
export const useColumnCount = (
  width = 0,
  columnWidth = 0,
  gutter = 8,
  columnCount?: number,
  maxColumnCount?: number
) =>
  useMemo(
    () => getColumnCount(width, columnWidth, gutter, columnCount, maxColumnCount),
    [width, columnWidth, gutter, columnCount, maxColumnCount]
  );

const getColumnCount = (
  width = 0,
  columnWidth = 0,
  gutter = 8,
  columnCount?: number,
  maxColumnCount?: number
) => {
  if (width === 0) return 0;
  return (
    columnCount ||
    Math.min(Math.floor((width + gutter) / (columnWidth + gutter)), maxColumnCount || Infinity) ||
    1
  );
};

export const useMasonryColumns = <TData>(
  data: TData[],
  columnWidth: number,
  columnCount: number,
  pick: (data: TData) => { height: number; width: number }
) =>
  useMemo(
    () => getMasonryColumns(data, columnWidth, columnCount, pick),
    [data, columnWidth, columnCount] // eslint-disable-line
  );

type ColumnItem<TData> = {
  height: number;
  data: TData;
};

const getMasonryColumns = <TData>(
  data: TData[],
  columnWidth: number,
  columnCount: number,
  pick: (data: TData) => { height: number; width: number },
  maxItemHeight?: number
): ColumnItem<TData>[][] => {
  // Track the height of each column.
  // Layout algorithm below always inserts into the shortest column.
  if (columnCount === 0) return [];

  console.log('calculating columns');

  const columnHeights: number[] = Array(columnCount).fill(0);
  const columnItems: ColumnItem<TData>[][] = Array(columnCount).fill([]);

  for (const item of data) {
    const { width: originalWidth, height: originalHeight } = pick(item);
    const ratioHeight = (originalHeight / originalWidth) * columnWidth;
    const height = maxItemHeight ? Math.min(ratioHeight, maxItemHeight) : ratioHeight;

    // look for the shortest column on each iteration
    let shortest = 0;
    for (let j = 1; j < columnCount; ++j) {
      if (columnHeights[j] < columnHeights[shortest]) {
        shortest = j;
      }
    }
    columnHeights[shortest] += height;
    columnItems[shortest] = [...columnItems[shortest], { height, data: item }];
    // columnItems[shortest].push(item);
  }

  console.log({ columnItems, columnHeights });

  return columnItems;
};

export const useContainerWidth = (elementRef: React.MutableRefObject<HTMLElement | null>) => {
  const [windowWidth, setWindowWidth] = useState(0);
  const [width, setWidth] = useState(0);

  useWindowEvent('resize', () => setWindowWidth(window.innerWidth));

  useLayoutEffect(() => {
    const { current } = elementRef;
    if (!current) return;
    setWidth(current.offsetWidth);
  }, [windowWidth, elementRef]);

  return width;
};
