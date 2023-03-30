import { Paper, Stack, Text, LoadingOverlay } from '@mantine/core';
import { createContext, useContext, useMemo } from 'react';

import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { trpc } from '~/utils/trpc';
import { useImageFilters } from '~/providers/FiltersProvider';
import { ImagesCard } from '~/components/Image/Infinite/ImagesCard';
import { removeEmpty } from '~/utils/object-helpers';
import { BrowsingMode } from '~/server/common/enums';
import { useRouter } from 'next/router';
import { parseImagesQueryParams } from '~/components/Image/image.utils';

type ImagesInfiniteState = {
  modelId?: number;
  modelVersionId?: number;
  postId?: number;
  username?: string;
  reviewId?: number;

  prioritizedUserIds?: number[];
  browsingMode?: BrowsingMode;
};
const ImagesInfiniteContext = createContext<ImagesInfiniteState | null>(null);
export const useImagesInfiniteContext = () => {
  const context = useContext(ImagesInfiniteContext);
  if (!context) throw new Error('ImagesInfiniteContext not in tree');
  return context;
};

type ImagesInfiniteProps = {
  columnWidth?: number;
  withTags?: boolean;
  filters?: ImagesInfiniteState;
};

export default function ImagesInfinite({
  columnWidth = 300,
  withTags,
  filters: filterOverrides = {},
}: ImagesInfiniteProps) {
  const router = useRouter();
  const globalFilters = useImageFilters();
  const parsedParams = parseImagesQueryParams(router.query);
  const baseFilters = { ...parsedParams, ...filterOverrides };
  const filters = removeEmpty({ ...baseFilters, ...globalFilters, withTags });

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching } =
    trpc.image.getInfinite.useInfiniteQuery(filters, {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      trpc: { context: { skipBatch: true } },
      keepPreviousData: true,
    });

  const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  return (
    <ImagesInfiniteContext.Provider value={baseFilters}>
      <MasonryGrid2
        data={images}
        hasNextPage={hasNextPage}
        isRefetching={isRefetching}
        isFetchingNextPage={isFetchingNextPage}
        fetchNextPage={fetchNextPage}
        columnWidth={columnWidth}
        render={ImagesCard}
        filters={filters}
      />
      {isLoading && (
        <Paper style={{ minHeight: 200, position: 'relative' }}>
          <LoadingOverlay visible zIndex={10} />
        </Paper>
      )}
      {!isLoading && !images.length && (
        <Paper p="xl" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Stack>
            <Text size="xl">There are no images to display</Text>
          </Stack>
        </Paper>
      )}
    </ImagesInfiniteContext.Provider>
  );
}
