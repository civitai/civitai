import { Stack, Group, Text, Loader, Center, Divider, Paper } from '@mantine/core';
import { RootThreadProvider, CreateComment, Comment } from '~/components/CommentsV2';
import classes from '~/components/CommentsV2/Comment/Comment.module.scss';
import { ReturnToRootThread } from '../CommentsV2/ReturnToRootThread';

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
      {({ data, created, isLoading, remaining, showMore, toggleShowMore, activeComment }) =>
        isLoading ? (
          <Center>
            <Loader variant="bars" />
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
