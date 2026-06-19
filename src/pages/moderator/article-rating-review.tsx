import { Badge, Button, Center, Group, Loader, Select, Stack, Title } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';

import { ArticleRatingReviewCard } from '~/components/Article/ArticleRatingReviewCard';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NoContent } from '~/components/NoContent/NoContent';

import { trpc } from '~/utils/trpc';

import { ReportStatus } from '~/shared/utils/prisma/enums';

const limitsData = [10, 25, 50, 100].map((num) => ({ value: String(num), label: `${num} items` }));

const statusData = [
  { value: ReportStatus.Pending, label: 'Pending' },
  { value: ReportStatus.Actioned, label: 'Approved' },
  { value: ReportStatus.Unactioned, label: 'Rejected' },
];

export default function ArticleRatingReview() {
  const [limit, setLimit] = useState<string>('50');
  const [status, setStatus] = useState<ReportStatus>(ReportStatus.Pending);

  const queryInput = useMemo(() => ({ limit: Number(limit), status }), [limit, status]);

  const utils = trpc.useUtils();

  // Reset paginated cache when the filter set changes so previous pages
  // from a different limit/status don't bleed into the new view.
  useEffect(() => {
    utils.article.getRatingReviews.reset();
    // utils is stable from tRPC; only react to filter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit, status]);

  const { data, isLoading, isFetching, fetchNextPage, hasNextPage } =
    trpc.article.getRatingReviews.useInfiniteQuery(queryInput, {
      getNextPageParam: (last) => last?.nextCursor,
    });

  // Queue depth across all buckets so mods can see how much work is waiting.
  const { data: counts } = trpc.article.getRatingReviewCounts.useQuery();

  const flatData = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-4">
        <Stack gap={6}>
          <Title>Article Rating Review</Title>
          {counts ? (
            <Group gap={6}>
              <Badge color="yellow" variant="light" size="lg">
                {counts.Pending} pending
              </Badge>
              <Badge color="teal" variant="light">
                {counts.Actioned} approved
              </Badge>
              <Badge color="red" variant="light">
                {counts.Unactioned} rejected
              </Badge>
            </Group>
          ) : null}
        </Stack>
        <Group gap={8}>
          <Select
            placeholder="Status"
            value={status}
            data={statusData}
            onChange={(value) => {
              if (value) setStatus(value as ReportStatus);
            }}
            allowDeselect={false}
          />
          <Select
            placeholder="Limit"
            value={limit}
            data={limitsData}
            onChange={(value) => {
              if (value) setLimit(value);
            }}
            allowDeselect={false}
          />
        </Group>
      </div>
      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : !flatData.length ? (
        <NoContent />
      ) : (
        <>
          <Stack gap="md">
            {flatData.map((review) => (
              <ArticleRatingReviewCard
                key={review.id}
                review={review}
                queryInput={queryInput}
              />
            ))}
          </Stack>
          {hasNextPage ? (
            <div className="flex justify-center">
              <Button size="lg" onClick={() => fetchNextPage()} loading={isFetching}>
                Next
              </Button>
            </div>
          ) : (
            <EndOfFeed />
          )}
        </>
      )}
    </div>
  );
}
