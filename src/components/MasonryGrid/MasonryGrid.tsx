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

export function MasonryGrid<T>({
  items,
  render,
  maxColumnCount = 4,
  columnWidth = 1200 / maxColumnCount,
  columnGutter,
  ...props
}: Props<T>) {
  const theme = useMantineTheme();
  const masonryRef = useRef(null);
  const { width, height } = useViewportSize();
  const { offset, width: containerWidth } = useContainerPosition(masonryRef, [width, height]);
  const positioner = usePositioner(
    {
      width: containerWidth,
      maxColumnCount: maxColumnCount,
      columnWidth: columnWidth,
      columnGutter: columnGutter ?? theme.spacing.md,
    },
    [items]
  );
  const resizeObserver = useResizeObserver(positioner);

  return (
    <MasonryScroller
      containerRef={masonryRef}
      positioner={positioner}
      resizeObserver={resizeObserver}
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
};
