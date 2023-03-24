import { Stack, Group, Text, Loader, Center, Divider } from '@mantine/core';
import {
  CommentsProvider,
  LoadNextPage,
  CreateComment,
  Comment,
  CommentV2BadgeProps,
} from '~/components/CommentsV2';

export function ModelDiscussionComments({
  commentId,
  userId,
}: {
  commentId: number;
  userId?: number;
}) {
  const badges: CommentV2BadgeProps[] = [];
  if (userId) badges.push({ userId, label: 'op', color: 'violet' });
  return (
    <CommentsProvider entityType="comment" entityId={commentId} limit={5} badges={badges}>
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
                        Show More
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
