import { Stack, Text, Loader, Center, Divider, Button } from '@mantine/core';
import { Comment } from '~/components/CommentsV2/Comment/Comment';
import { RootThreadProvider } from '~/components/CommentsV2/CommentsProvider';
import { CreateComment } from '~/components/CommentsV2/Comment/CreateComment';
import { ReturnToRootThread } from '../../CommentsV2/ReturnToRootThread';
import classes from '~/components/CommentsV2/Comment/Comment.module.css';

type ImageDetailCommentsProps = {
  imageId: number;
  userId: number;
};

export function ImageDetailComments({ imageId, userId }: ImageDetailCommentsProps) {
  return (
    <RootThreadProvider
      entityType="image"
      entityId={imageId}
      badges={[{ userId, label: 'op', color: 'violet' }]}
      limit={3}
      key={imageId}
    >
      {({ data, created, isLoading, isFetching, showMore, toggleShowMore, activeComment }) =>
        isLoading ? (
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
                  <Button onClick={toggleShowMore} loading={isFetching} variant="subtle" size="md">
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
