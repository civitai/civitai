import { useMantineTheme } from '@mantine/core';
import { useViewportSize } from '@mantine/hooks';
import {
  MasonryScroller,
  MasonryScrollerProps,
  useContainerPosition,
  usePositioner,
  useResizeObserver,
} from 'masonic';
import { useRef } from 'react';
import { usePrevious } from '@mantine/hooks';

export function MasonryGrid<T>({
  items,
  render,
  maxColumnCount = 4,
  columnWidth = 1200 / maxColumnCount,
  columnGutter,
  filters,
  isRefetching,
  isFetchingNextPage,
  ...props
}: Props<T>) {
  const counterRef = useRef(0);
  const theme = useMantineTheme();
  const masonryRef = useRef(null);
  const { width, height } = useViewportSize();
  const { offset, width: containerWidth } = useContainerPosition(masonryRef, [width, height]);
  const previousFetching = usePrevious(isRefetching && !isFetchingNextPage);
  if (previousFetching) counterRef.current++;
  // when add/edit/delete
  const positioner = usePositioner(
    {
      width: containerWidth,
      maxColumnCount: maxColumnCount,
      columnWidth: columnWidth,
      columnGutter: columnGutter ?? theme.spacing.md,
    },
    [counterRef.current]
  );
  const resizeObserver = useResizeObserver(positioner);

  return (
    <MasonryScroller
      containerRef={masonryRef}
      positioner={positioner}
      resizeObserver={resizeObserver}
      overscanBy={10}
      offset={offset}
      height={height}
      items={items}
      render={render}
      {...props}
    />
  );
}

type Props<T> = Omit<
  MasonryScrollerProps<T>,
  'containerRef' | 'positioner' | 'resizeObserver' | 'offset' | 'height'
> & {
  maxColumnCount?: number;
  columnWidth?: number;
  columnGutter?: number;
  filters?: Record<string, unknown>;
  previousFetching?: boolean;
  isRefetching: boolean;
  isFetchingNextPage: boolean;
};
