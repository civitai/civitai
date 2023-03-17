import { useMantineTheme, Center, Loader } from '@mantine/core';
import {
  useContainerPosition,
  useMasonry,
  UseMasonryOptions,
  usePositioner,
  useResizeObserver,
  useScroller,
  useScrollToIndex,
} from 'masonic';
import { useEffect, useRef } from 'react';
import { usePrevious } from '@mantine/hooks';
import { useWindowSize } from '@react-hook/window-size';
import { useInView } from 'react-intersection-observer';

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
  fetchNextPage?: () => void;
  /** using the data in the grid, determine the index to scroll to */
  scrollToIndex?: (data: TData[]) => number;
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
  ...masonicProps
}: Props<T, TFilters>) {
  const theme = useMantineTheme();
  const { ref, inView } = useInView();

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
  const { offset, width: containerWidth } = useContainerPosition(containerRef, [width, height]);
  const positioner = usePositioner(
    {
      width: containerWidth,
      maxColumnCount: maxColumnCount,
      columnWidth,
      columnGutter: columnGutter ?? theme.spacing.md,
    },
    [positionerDep]
  );
  const resizeObserver = useResizeObserver(positioner);
  // #endregion

  // #region [masonic scroll settings]
  const { scrollTop, isScrolling } = useScroller(offset);
  const scrollTo = useScrollToIndex(positioner, { offset, height, align: 'center' });
  useEffect(() => {
    if (!data || !scrollToIndex) return;
    const index = scrollToIndex(data);
    if (index > -1) scrollTo(index);
  }, []); // eslint-disable-line
  // #endregion

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView) {
      fetchNextPage?.();
    }
  }, [fetchNextPage, inView]);
  // #endregion

  return (
    <>
      {useMasonry({
        resizeObserver,
        positioner,
        scrollTop,
        isScrolling,
        height,
        containerRef,
        items: data,
        overscanBy: 10,
        // render: MasonryCard,
        ...masonicProps,
      })}
      {hasNextPage && (
        <Center ref={ref}>
          <Loader />
        </Center>
      )}
    </>
  );
}
