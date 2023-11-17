import { useMantineTheme, Center, Loader, Button, LoadingOverlay } from '@mantine/core';
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
import { InViewLoader } from '../InView/InViewLoader';

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
  ...masonicProps
}: Props<T, TFilters>) {
  const theme = useMantineTheme();

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

  return (
    <div style={{ position: 'relative' }}>
      <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
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
      {hasNextPage &&
        (autoFetch ? (
          <InViewLoader
            loadFn={fetchNextPage}
            loadCondition={!isRefetching}
            style={{ gridColumn: '1/-1' }}
          >
            <Center p="xl" sx={{ height: 36 }} mt="md">
              <Loader />
            </Center>
          </InViewLoader>
        ) : (
          <Center>
            <Button
              onClick={fetchNextPage}
              loading={isFetchingNextPage}
              color="gray"
              variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
            >
              {isFetchingNextPage ? 'Loading more...' : 'Load more'}
            </Button>
          </Center>
        ))}
    </div>
  );
}
