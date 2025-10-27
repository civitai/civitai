import { Stack, Text, Loader, Center, Divider, Button } from '@mantine/core';
import { Comment } from '~/components/CommentsV2/Comment/Comment';
import { RootThreadProvider } from '~/components/CommentsV2/CommentsProvider';
import { CreateComment } from '~/components/CommentsV2/Comment/CreateComment';
import { ReturnToRootThread } from '../CommentsV2/ReturnToRootThread';
import classes from '~/components/CommentsV2/Comment/Comment.module.css';

type Props = {
  bountyId: number;
  userId?: number;
};

export function BountyDiscussion({ bountyId, userId }: Props) {
  return (
    <RootThreadProvider
      entityType="bounty"
      entityId={bountyId}
      limit={20}
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
              <CreateComment />
              {(data?.length || created.length) > 0 && (
                <Stack className="relative">
                  {data?.map((comment) => (
                    <Comment key={comment.id} comment={comment} />
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
                    <Comment key={comment.id} comment={comment} />
                  ))}
                </Stack>
              )}
            </Stack>
          </Stack>
        )
      }
    </RootThreadProvider>
  );
}
