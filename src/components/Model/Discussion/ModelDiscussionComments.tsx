import { Stack, Loader, Center, Button } from '@mantine/core';
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
      {({ data, created, isLoading, isFetching, showMore, toggleShowMore }) =>
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
            {showMore && (
              <Center>
                <Button onClick={toggleShowMore} loading={isFetching} variant="subtle" size="md">
                  Load More Comments
                </Button>
              </Center>
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
