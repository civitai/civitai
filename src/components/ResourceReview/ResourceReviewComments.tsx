import { Stack, Group, Text, Loader, Center, Divider } from '@mantine/core';
import { CommentsProvider, LoadNextPage, CreateComment, Comment } from '~/components/CommentsV2';

export function ResourceReviewComments({ reviewId, userId }: { reviewId: number; userId: number }) {
  return (
    <CommentsProvider
      entityType="review"
      entityId={reviewId}
      limit={3}
      badges={[{ userId, label: 'op', color: 'violet' }]}
    >
      {({ data, created, isInitialLoading, isFetching }) =>
        isInitialLoading ? (
          <Center>
            <Loader variant="bars" />
          </Center>
        ) : (
          <Stack>
            <CreateComment />
            {data?.map((comment) => (
              <Comment key={comment.id} comment={comment} />
            ))}
            <LoadNextPage>
              {({ remaining, onClick }) => (
                <Divider
                  label={
                    <Group spacing="xs" align="center">
                      {isFetching && <Loader size="xs" />}
                      <Text variant="link" sx={{ cursor: 'pointer' }} onClick={onClick}>
                        Show more
                      </Text>
                    </Group>
                  }
                  labelPosition="center"
                  variant="dashed"
                />
              )}
            </LoadNextPage>
            {created.map((comment) => (
              <Comment key={comment.id} comment={comment} />
            ))}
          </Stack>
        )
      }
    </CommentsProvider>
  );
}
