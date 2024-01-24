import { Stack, Group, Text, Loader, Center, Divider, Paper } from '@mantine/core';
import {
  RootThreadProvider,
  CreateComment,
  Comment,
  useCommentStyles,
} from '~/components/CommentsV2';
import { ReturnToRootThread } from '../CommentsV2/ReturnToRootThread';

type Props = {
  bountyId: number;
  userId?: number;
};

export function BountyDiscussion({ bountyId, userId }: Props) {
  const { classes } = useCommentStyles();

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
              <CreateComment />
              {(data?.length || created.length) > 0 && (
                <>
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
                </>
              )}
            </Stack>
          </Stack>
        )
      }
    </RootThreadProvider>
  );
}
