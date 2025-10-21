import { Stack, Text, Loader, Center, Divider, Button } from '@mantine/core';
import { Comment } from '~/components/CommentsV2/Comment/Comment';
import { RootThreadProvider } from '~/components/CommentsV2/CommentsProvider';
import { CreateComment } from '~/components/CommentsV2/Comment/CreateComment';
import { ReturnToRootThread } from '../CommentsV2/ReturnToRootThread';
import classes from '~/components/CommentsV2/Comment/Comment.module.css';

type Props = {
  bountyEntryId: number;
  userId?: number;
  showEmptyState?: boolean;
};

export function BountyEntryDiscussion({ bountyEntryId, userId, showEmptyState }: Props) {
  return (
    <RootThreadProvider
      entityType="bountyEntry"
      entityId={bountyEntryId}
      limit={3}
      badges={userId ? [{ userId, label: 'op', color: 'violet' }] : []}
    >
      {({
        data,
        created,
        isLoading,
        isFetching,
        isFetchingNextPage,
        showMore,
        toggleShowMore,
        activeComment,
      }) =>
        isLoading || isFetching ? (
          <Center>
            <Loader type="bars" />
          </Center>
        ) : (
          <Stack>
            <ReturnToRootThread />
            {activeComment && (
              <Stack gap="xl">
                <Divider />
                <Text size="sm" c="dimmed">
                  Viewing thread for
                </Text>
                <Comment comment={activeComment} viewOnly />
              </Stack>
            )}
            <Stack className={activeComment ? classes.rootCommentReplyInset : undefined}>
              <CreateComment key={activeComment?.id} borderless />
              {data?.map((comment) => (
                <Comment key={comment.id} comment={comment} borderless />
              ))}
              {showMore && (
                <Center>
                  <Button
                    onClick={toggleShowMore}
                    loading={isFetchingNextPage}
                    variant="subtle"
                    size="md"
                  >
                    Load More Comments
                  </Button>
                </Center>
              )}
              {created.map((comment) => (
                <Comment key={comment.id} comment={comment} borderless />
              ))}
            </Stack>
          </Stack>
        )
      }
    </RootThreadProvider>
  );
}
