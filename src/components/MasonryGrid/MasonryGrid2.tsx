import {
  useMantineTheme,
  Center,
  Loader,
  Button,
  LoadingOverlay,
  useComputedColorScheme,
} from '@mantine/core';
import type { UseMasonryOptions } from 'masonic';
import {
  useContainerPosition,
  useMasonry,
  usePositioner,
  useResizeObserver,
  useScrollToIndex,
} from 'masonic';
import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { usePrevious } from '@mantine/hooks';
import { useWindowSize } from '@react-hook/window-size';
import { InViewLoader } from '../InView/InViewLoader';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useScrollMargin } from '~/hooks/useScrollMargin';

/**
 * masonic's own `useScroller` reads `window.scrollY`, but the app scrolls its ScrollArea and the
 * window never moves. Fed that, masonic never renders items below the first screens and pads the
 * grid with estimated heights for them instead.
 */
function useScrollAreaScroller(
  containerRef: RefObject<HTMLElement | null>,
  fallbackHeight: number
) {
  const scrollAreaRef = useScrollAreaRef();
  const scrollMargin = useScrollMargin(containerRef);
  const [scrollAreaTop, setScrollAreaTop] = useState(0);
  const [isScrolling, setIsScrolling] = useState(false);

  useEffect(() => {
    const node = scrollAreaRef?.current;
    if (!node) return;
    let frame: number | undefined;
    const handleScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        setScrollAreaTop(node.scrollTop);
        frame = undefined;
      });
    };
    handleScroll();
    node.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      node.removeEventListener('scroll', handleScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollAreaRef]);

  useEffect(() => {
    setIsScrolling(true);
    const timeout = window.setTimeout(() => setIsScrolling(false), 1000 / 6);
    return () => window.clearTimeout(timeout);
  }, [scrollAreaTop]);

  return {
    scrollTop: Math.max(0, scrollAreaTop - scrollMargin),
    isScrolling,
    height: scrollAreaRef?.current?.clientHeight || fallbackHeight,
  };
}

type Props<TData, TFilters extends Record<string, unknown>> = Omit<
  UseMasonryOptions<TData>,
  | 'containerRef'
  | 'positioner'
  | 'resizeObserver'
  | 'offset'
  | 'height'
  | 'items'
  | 'scrollTop'
  | 'isScrolling'
> & {
  data?: TData[];
  isLoading?: boolean;
  hasNextPage?: boolean;
  isRefetching?: boolean;
  isFetchingNextPage?: boolean;
  columnWidth: number;
  columnGutter?: number;
  maxColumnCount?: number;
  filters: TFilters;
  autoFetch?: boolean;
  fetchNextPage: VoidFunction;
  /** using the data in the grid, determine the index to scroll to */
  scrollToIndex?: (data: TData[]) => number;
  overscanBy?: number;
};

export function MasonryGrid2<T, TFilters extends Record<string, unknown>>({
  data = [],
  isLoading,
  hasNextPage,
  isRefetching,
  isFetchingNextPage,
  columnWidth,
  columnGutter,
  maxColumnCount,
  scrollToIndex,
  fetchNextPage,
  filters,
  autoFetch = true,
  overscanBy = 10,
  ...masonicProps
}: Props<T, TFilters>) {
  const colorScheme = useComputedColorScheme('dark');

  // #region [track data/filter changes]
  const stringified = JSON.stringify(filters);
  const previousFilters = usePrevious(stringified);
  const filtersChanged = previousFilters !== stringified;
  const prevData = usePrevious(data) ?? [];

  const currentFetching = isRefetching && !isFetchingNextPage;
  const previousFetching = usePrevious(isRefetching && !isFetchingNextPage);
  const positionerDep =
    (previousFetching && !currentFetching) ||
    (filtersChanged && !currentFetching && prevData.length !== data.length);
  // #endregion

  // #region [base masonic settings]
  const containerRef = useRef(null);
  const [width, height] = useWindowSize();
  const scrollHeight = typeof window === 'undefined' ? 0 : document?.documentElement.scrollHeight;
  const { offset, width: containerWidth } = useContainerPosition(containerRef, [
    width,
    height,
    scrollHeight,
  ]);
  const positioner = usePositioner(
    {
      width: containerWidth,
      maxColumnCount: maxColumnCount,
      columnWidth,
      columnGutter: columnGutter ?? 16,
    },
    [positionerDep]
  );
  const resizeObserver = useResizeObserver(positioner);
  // #endregion

  // #region [masonic scroll settings]
  const {
    scrollTop,
    isScrolling,
    height: viewportHeight,
  } = useScrollAreaScroller(containerRef, height);
  const scrollTo = useScrollToIndex(positioner, { offset, height, align: 'center' });
  useEffect(() => {
    if (!data || !scrollToIndex) return;
    const index = scrollToIndex(data);
    if (index > -1) scrollTo(index);
  }, []); // eslint-disable-line
  // #endregion

  return (
    <div style={{ position: 'relative' }}>
      <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
      {useMasonry({
        resizeObserver,
        positioner,
        scrollTop,
        isScrolling,
        height: viewportHeight,
        containerRef,
        items: data,
        overscanBy,
        // render: MasonryCard,
        ...masonicProps,
      })}
      {hasNextPage &&
        (autoFetch ? (
          <InViewLoader
            loadFn={fetchNextPage}
            loadCondition={!isRefetching}
            style={{ gridColumn: '1/-1' }}
          >
            <Center p="xl" style={{ height: 36 }} mt="md">
              <Loader />
            </Center>
          </InViewLoader>
        ) : (
          <Center>
            <Button
              onClick={fetchNextPage}
              loading={isFetchingNextPage}
              color="gray"
              variant={colorScheme === 'dark' ? 'filled' : 'light'}
            >
              {isFetchingNextPage ? 'Loading more...' : 'Load more'}
            </Button>
          </Center>
        ))}
    </div>
  );
}
