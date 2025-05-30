import { Stack, Text, Loader, Center, Divider } from '@mantine/core';
import { Comment, useCommentStyles } from '~/components/CommentsV2';
import { RootThreadProvider } from '~/components/CommentsV2/CommentsProvider';
import { CreateComment } from '~/components/CommentsV2/Comment/CreateComment';
import { ReturnToRootThread } from '../../CommentsV2/ReturnToRootThread';

type ImageDetailCommentsProps = {
  imageId: number;
  userId: number;
};

export function ImageDetailComments({ imageId, userId }: ImageDetailCommentsProps) {
  const { classes } = useCommentStyles();

  return (
    <RootThreadProvider
      entityType="image"
      entityId={imageId}
      badges={[{ userId, label: 'op', color: 'violet' }]}
      limit={3}
      key={imageId}
    >
      {({ data, created, isLoading, remaining, showMore, toggleShowMore, activeComment }) =>
        isLoading ? (
          <Center>
            <Loader variant="bars" />
          </Center>
        ) : (
          <Stack>
            <ReturnToRootThread />
            {activeComment && (
              <Stack spacing="xl">
                <Divider />
                <Text size="sm" color="dimmed">
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
              {!!remaining && !showMore && (
                <div className="flex justify-center">
                  <Text variant="link" className="cursor-pointer text-sm" onClick={toggleShowMore}>
                    Show {remaining} More
                  </Text>
                </div>
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
