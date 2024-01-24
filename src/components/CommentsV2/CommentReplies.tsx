import { Stack, Group, Text, Loader, Center, Divider } from '@mantine/core';
import {
  CommentsProvider,
  CreateComment,
  Comment,
  CommentV2BadgeProps,
  useCommentsContext,
  useCommentStyles,
} from '~/components/CommentsV2';

export function CommentReplies({ commentId, userId }: { commentId: number; userId?: number }) {
  const { level, badges } = useCommentsContext();
  const { classes } = useCommentStyles();

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
    </Stack>
  );
}
