import { Button, Center, Grid, LoadingOverlay, Paper, Stack, Text } from '@mantine/core';
import React, { useMemo } from 'react';
import { InView } from 'react-intersection-observer';

import { MasonryGrid } from '~/components/MasonryGrid/MasonryGrid';
import { CommentDiscussionItem } from '~/components/Model/ModelDiscussion/CommentDiscussionItem';
import { ReviewDiscussionItem } from '~/components/Model/ModelDiscussion/ReviewDiscussionItem';
import { ReviewSort } from '~/server/common/enums';
import { CommentGetAllItem, ReviewGetAllItem } from '~/types/router';
import { trpc } from '~/utils/trpc';

export function ModelDiscussion({ modelId }: Props) {
  const {
    data: reviewsData,
    isLoading: loadingReviews,
    isFetchingNextPage: fetchingReviews,
    fetchNextPage: fetchNextReviews,
    hasNextPage: hasMoreReviews,
    isRefetching: refetchingReviews,
  } = trpc.review.getAll.useInfiniteQuery(
    { modelId, limit: 12, sort: ReviewSort.Newest },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      keepPreviousData: false,
    }
  );
  const {
    data: commentsData,
    isLoading: loadingComments,
    isFetchingNextPage: fetchingComments,
    fetchNextPage: fetchNextComments,
    hasNextPage: hasMoreComments,
    isRefetching: refetchingComments,
  } = trpc.comment.getAll.useInfiniteQuery(
    { modelId, limit: 12, sort: ReviewSort.Newest },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      keepPreviousData: false,
    }
  );

  const reviews = useMemo(
    () => reviewsData?.pages.flatMap((x) => x.reviews) ?? [],
    [reviewsData?.pages]
  );
  const comments = useMemo(
    () => commentsData?.pages.flatMap((x) => x.comments) ?? [],
    [commentsData?.pages]
  );
  const items = useMemo(
    () => [...reviews, ...comments].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    [comments, reviews]
  );
  const loading = loadingReviews || loadingComments;
  const fetching = fetchingReviews || fetchingComments;
  const hasNextPage = hasMoreReviews || hasMoreComments;
  const hasItems = reviews.length > 0 || comments.length > 0;

  return (
    <Grid gutter="xl">
      <Grid.Col span={12} sx={{ position: 'relative' }}>
        <LoadingOverlay visible={loading} />
        {hasItems ? (
          <MasonryGrid
            items={items}
            render={DiscussionItem}
            isRefetching={refetchingComments || refetchingReviews}
            isFetchingNextPage={fetchingComments || fetchingReviews}
          />
        ) : (
          <Paper p="xl" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Stack>
              <Text size="xl">There are no reviews for this model yet.</Text>
              <Text color="dimmed">
                Be the first to let the people know about this model by leaving your review.
              </Text>
            </Stack>
          </Paper>
        )}
      </Grid.Col>
      {/* At the bottom to detect infinite scroll */}
      {hasItems ? (
        <Grid.Col span={12}>
          <Center>
            <InView
              fallbackInView
              threshold={1}
              onChange={(inView) => {
                if (inView && !fetching) {
                  if (hasMoreReviews) fetchNextReviews();
                  if (hasMoreComments) fetchNextComments();
                }
              }}
            >
              {({ ref }) => (
                <Button
                  ref={ref}
                  variant="subtle"
                  fullWidth
                  onClick={() => {
                    if (hasMoreReviews) fetchNextReviews();
                    if (hasMoreComments) fetchNextComments();
                  }}
                  disabled={!hasNextPage || fetching}
                >
                  {fetching
                    ? 'Loading more...'
                    : hasNextPage
                    ? 'Load More'
                    : 'Nothing more to load'}
                </Button>
              )}
            </InView>
          </Center>
        </Grid.Col>
      ) : null}
    </Grid>
  );
}

export const ModelDiscussion2 = React.memo(ModelDiscussion);

type Props = {
  modelId: number;
  // filters: { filterBy: ReviewFilter[]; sort: ReviewSort };
};

function DiscussionItem({ data, width }: ItemProps) {
  return 'rating' in data ? (
    <ReviewDiscussionItem review={data} width={width} />
  ) : (
    <CommentDiscussionItem comment={data} />
  );
}

type ItemProps = {
  data: ReviewGetAllItem | CommentGetAllItem;
  width: number;
};
