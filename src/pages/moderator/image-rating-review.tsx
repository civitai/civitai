import { Center, Container, Loader } from '@mantine/core';
import { useMemo } from 'react';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NoContent } from '~/components/NoContent/NoContent';
import { trpc } from '~/utils/trpc';

export default function ImageRatingReview() {
  const { data, isLoading, hasNextPage, fetchNextPage, isRefetching } =
    trpc.image.getImageRatingRequests.useInfiniteQuery(
      { limit: 5 },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );

  const flatData = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);

  return (
    <>
      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : !flatData?.length ? (
        <NoContent />
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-5">
            {flatData?.map((item) => (
              <div key={item.id}>{item.url}</div>
            ))}
          </div>
          {hasNextPage && (
            <InViewLoader
              loadFn={fetchNextPage}
              loadCondition={!isRefetching && hasNextPage}
              // Forces a re-render whenever the amount of images fetched changes. Forces load-more if available.
              style={{ gridColumn: '1/-1' }}
            >
              <Center p="xl" sx={{ height: 36 }} mt="md">
                <Loader />
              </Center>
            </InViewLoader>
          )}
          {!hasNextPage && <EndOfFeed />}
        </>
      )}
    </>
  );
}
