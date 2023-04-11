import {
  MasonryAdjustHeightFn,
  MasonryImageDimensionsFn,
} from '~/components/MasonryColumns/masonry.types';
import { useWindowEvent } from '@mantine/hooks';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createDebouncer } from '~/utils/debouncer';

// don't know if I need memoized
export const useColumnCount = (width = 0, columnWidth = 0, gutter = 8, maxColumnCount?: number) =>
  useMemo(
    () => getColumnCount(width, columnWidth, gutter, maxColumnCount),
    [width, columnWidth, gutter, maxColumnCount]
  );

const getColumnCount = (width = 0, columnWidth = 0, gutter = 8, maxColumnCount?: number) => {
  if (width === 0) return [0, 0];
  const count =
    Math.min(Math.floor((width + gutter) / (columnWidth + gutter)), maxColumnCount || Infinity) ||
    1;
  const combinedWidth = count * columnWidth + (count - 1) * gutter;
  return [count, combinedWidth];
};

export const useMasonryColumns = <TData>(
  data: TData[],
  columnWidth: number,
  columnCount: number,
  imageDimensions: MasonryImageDimensionsFn<TData>,
  adjustDimensions?: MasonryAdjustHeightFn,
  maxItemHeight?: number
) =>
  useMemo(
    () =>
      getMasonryColumns(
        data,
        columnWidth,
        columnCount,
        imageDimensions,
        adjustDimensions,
        maxItemHeight
      ),
    [data, columnWidth, columnCount, maxItemHeight] // eslint-disable-line
  );

type ColumnItem<TData> = {
  height: number;
  data: TData;
};

const getMasonryColumns = <TData>(
  data: TData[],
  columnWidth: number,
  columnCount: number,
  imageDimensions: MasonryImageDimensionsFn<TData>,
  adjustHeight?: MasonryAdjustHeightFn,
  maxItemHeight?: number
): ColumnItem<TData>[][] => {
  // Track the height of each column.
  // Layout algorithm below always inserts into the shortest column.
  if (columnCount === 0) return [];

  const columnHeights: number[] = Array(columnCount).fill(0);
  const columnItems: ColumnItem<TData>[][] = Array(columnCount).fill([]);

  for (const item of data) {
    const { width: originalWidth, height: originalHeight } = imageDimensions(item);

    const ratioHeight = (originalHeight / originalWidth) * columnWidth;
    const adjustedHeight =
      adjustHeight?.({
        imageRatio: columnWidth / ratioHeight,
        width: columnWidth,
        height: ratioHeight,
      }) ?? ratioHeight;
    const height = maxItemHeight ? Math.min(adjustedHeight, maxItemHeight) : adjustedHeight;

    // look for the shortest column on each iteration
    let shortest = 0;
    for (let j = 1; j < columnCount; ++j) {
      if (columnHeights[j] < columnHeights[shortest]) {
        shortest = j;
      }
    }
    columnHeights[shortest] += height;
    columnItems[shortest] = [...columnItems[shortest], { height, data: item }];
  }

  return columnItems;
};

const windowResizeDebouncer = createDebouncer(300);
export const useContainerWidth = (elementRef: React.MutableRefObject<HTMLElement | null>) => {
  const { current: container } = elementRef;
  const [windowWidth, setWindowWidth] = useState(0);
  const [width, setWidth] = useState(0);

  useWindowEvent('resize', () =>
    windowResizeDebouncer(() => {
      setWindowWidth(window.innerWidth);
    })
  );

  // using the extra `container?.offsetWidth` dependency because of rapid changes in offsetWidth value on initialize
  useEffect(() => {
    const { current } = elementRef;
    if (!current?.offsetWidth) return;
    setWidth(current.offsetWidth);
  }, [windowWidth, container?.offsetWidth, elementRef]);

  return width;
};
