import { ScrollArea } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { useMasonry, UseMasonryOptions, usePositioner, useResizeObserver } from 'masonic';
import { useState } from 'react';
import { useIsomorphicLayoutEffect } from '~/hooks/useIsomorphicLayoutEffect';

/**
 * Taken from https://github.com/jaredLunde/mini-virtual-list/blob/5791a19581e25919858c43c37a2ff0eabaf09bfe/src/index.tsx#L414
 */
const useScroller = <T extends HTMLElement = HTMLElement>(
  ref: React.MutableRefObject<T | null>
): { scrollTop: number; isScrolling: boolean } => {
  const [isScrolling, setIsScrolling] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);

  useIsomorphicLayoutEffect(() => {
    const { current } = ref;
    let tick: number | undefined;

    if (current) {
      const handleScroll = () => {
        if (tick) return;
        tick = window.requestAnimationFrame(() => {
          setScrollTop(current.scrollTop);
          tick = void 0;
        });
      };

      current.addEventListener('scroll', handleScroll);
      return () => {
        current.removeEventListener('scroll', handleScroll);
        if (tick) window.cancelAnimationFrame(tick);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.current]);

  useIsomorphicLayoutEffect(() => {
    setIsScrolling(true);
    const to = window.setTimeout(() => {
      // This is here to prevent premature bail outs while maintaining high resolution
      // unsets. Without it there will always bee a lot of unnecessary DOM writes to style.
      setIsScrolling(false);
    }, 1000 / 6);
    return () => window.clearTimeout(to);
  }, [scrollTop]);

  return { scrollTop, isScrolling };
};

/**
 * Use this when you need just a list of virtualized items in a grid
 */
export function BasicMasonryGrid<T>({
  maxHeight,
  render,
  items,
  columnGutter,
  columnWidth,
  maxColumnCount = 4,
  ...props
}: Props<T>) {
  const { ref: containerRef, width, height } = useElementSize<HTMLDivElement>();
  const positioner = usePositioner({ width, columnGutter, columnWidth, maxColumnCount }, [
    items.length,
  ]);
  const resizeObserver = useResizeObserver(positioner);
  const { scrollTop, isScrolling } = useScroller(containerRef);

  const MasonryList = useMasonry({
    items,
    render,
    positioner,
    resizeObserver,
    scrollTop,
    isScrolling,
    height,
    overscanBy: 5,
    ...props,
  });

  return (
    <ScrollArea.Autosize
      viewportRef={containerRef}
      mah={maxHeight}
      style={{ position: 'relative', width: '100%' }}
      type="hover"
    >
      {MasonryList}
    </ScrollArea.Autosize>
  );
}

type Props<T> = Omit<
  UseMasonryOptions<T>,
  'scrollTop' | 'positioner' | 'resizeObserver' | 'isScrolling' | 'height'
> & {
  maxHeight: number;
  maxColumnCount?: number;
  columnWidth?: number;
  columnGutter?: number;
};
