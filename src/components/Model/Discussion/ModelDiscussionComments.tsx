import { Stack, Group, Text, Loader, Center, Divider } from '@mantine/core';
import { Comment } from '~/components/CommentsV2/Comment/Comment';
import type { CommentV2BadgeProps } from '~/components/CommentsV2/CommentsProvider';
import { RootThreadProvider } from '~/components/CommentsV2/CommentsProvider';
import { CreateComment } from '~/components/CommentsV2/Comment/CreateComment';

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
    <RootThreadProvider entityType="comment" entityId={commentId} limit={5} badges={badges}>
      {({ data, created, isLoading, remaining, showMore, toggleShowMore }) =>
        isLoading ? (
          <Center>
            <Loader type="bars" />
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
                  <Group gap="xs" align="center">
                    <Text
                      c="blue.4"
                      size="xs"
                      style={{ cursor: 'pointer' }}
                      onClick={toggleShowMore}
                    >
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
    </RootThreadProvider>
  );
}
