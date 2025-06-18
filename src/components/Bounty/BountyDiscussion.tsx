import { Stack, Group, Text, Loader, Center, Divider, Paper } from '@mantine/core';
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
      {({ data, created, isLoading, remaining, showMore, toggleShowMore, activeComment }) =>
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
              <CreateComment />
              {(data?.length || created.length) > 0 && (
                <>
                  {data?.map((comment) => (
                    <Comment key={comment.id} comment={comment} />
                  ))}
                  {!!remaining && !showMore && (
                    <Divider
                      label={
                        <Group gap="xs" align="center">
                          <Text c="blue.4" style={{ cursor: 'pointer' }} onClick={toggleShowMore}>
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
                </>
              )}
            </Stack>
          </Stack>
        )
      }
    </RootThreadProvider>
  );
}
