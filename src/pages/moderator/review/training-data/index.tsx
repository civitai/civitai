import { Title, Text, Button, Loader } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

export default function TrainingDataReviewPage() {
  const router = useRouter();
  const { data, isFetching, hasNextPage, fetchNextPage } =
    trpc.moderator.modelVersions.query.useInfiniteQuery(
      {
        limit: 20,
        trainingStatus: 'Paused',
      },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      }
    );

  const flatData = useMemo(() => data?.pages.flatMap((x) => x.items), [data]);

  return (
    <div className="container max-w-sm p-3">
      <Title order={1}>Review training data</Title>
      <div className="flex flex-col gap-3">
        {flatData?.map((item) => (
          <div key={item.id} className="flex items-center justify-between gap-3 p-3 card">
            <div className="flex flex-col">
              <Text lineClamp={1}>{item.name}</Text>
              <Text color="dimmed" size="xs">
                Created: {formatDate(item.createdAt)}
              </Text>
            </div>
            <Button compact component={NextLink} href={`${router.asPath}/${item.id}`}>
              Review
            </Button>
          </div>
        ))}
      </div>
      {hasNextPage && (
        <InViewLoader loadFn={fetchNextPage} loadCondition={!isFetching}>
          <div className="mt-3 flex justify-center p-3">
            <Loader />
          </div>
        </InViewLoader>
      )}
    </div>
  );
}
