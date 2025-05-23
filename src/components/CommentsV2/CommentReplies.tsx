import { Stack, Group, Text, Loader, Center, Divider } from '@mantine/core';
import { CommentsProvider, Comment, useCommentsContext } from '~/components/CommentsV2';
import classes from '~/components/CommentsV2/Comment/Comment.module.css';

export function CommentReplies({ commentId, userId }: { commentId: number; userId?: number }) {
  const { level, badges } = useCommentsContext();

  return (
    <Stack mt="md" className={classes.replyInset}>
      <CommentsProvider
        entityType="comment"
        entityId={commentId}
        badges={badges}
        level={(level ?? 0) + 1}
      >
        {({ data, created, isLoading, remaining, showMore, toggleShowMore }) =>
          isLoading ? (
            <Center>
              <Loader variant="bars" />
            </Center>
          ) : (
            <Stack>
              {data?.map((comment) => (
                <Comment key={comment.id} comment={comment} />
              ))}
              {!!remaining && !showMore && (
                <Divider
                  label={
                    <Group gap="xs" align="center">
                      <Text variant="link" style={{ cursor: 'pointer' }} onClick={toggleShowMore}>
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
    </Stack>
  );
}
