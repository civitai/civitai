import { Stack, Group, Text, Loader, Center, Divider } from '@mantine/core';
import {
  CommentsProvider,
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
      {({ data, created, isLoading, remaining, showMore, toggleShowMore }) =>
        isLoading ? (
          <Center>
            <Loader variant="bars" />
          </Center>
        ) : (
          <Stack>
            <CreateComment />
            {data?.map((comment) => (
              <Comment key={comment.id} comment={comment} />
            ))}
            {!!remaining && !showMore && (
              <Divider
                label={
                  <Group spacing="xs" align="center">
                    <Text variant="link" sx={{ cursor: 'pointer' }} onClick={toggleShowMore}>
                      Show {remaining} More
                    </Text>
                  </Group>
                }
                labelPosition="center"
                variant="dashed"
              />
            )}
            {created.map((comment) => (
              <Comment key={comment.id} comment={comment} />
            ))}
          </Stack>
        )
      }
    </CommentsProvider>
  );
}
