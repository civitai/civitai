import { Stack, Group, Text, Loader, Center, Divider, Paper } from '@mantine/core';
import {
  RootThreadProvider,
  CreateComment,
  Comment,
  useCommentStyles,
} from '~/components/CommentsV2';
import { ReturnToRootThread } from '../CommentsV2/ReturnToRootThread';

type Props = {
  bountyEntryId: number;
  userId?: number;
  showEmptyState?: boolean;
};

export function BountyEntryDiscussion({ bountyEntryId, userId, showEmptyState }: Props) {
  const { classes } = useCommentStyles();

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
              {data?.length || created.length ? (
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
              ) : showEmptyState ? (
                <Paper
                  p="xl"
                  radius="md"
                  sx={(theme) => ({
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor:
                      theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
                  })}
                >
                  <Stack spacing="sm" align="center">
                    <Text size={24} weight={600} align="center">
                      No comments yet
                    </Text>
                    <Text color="dimmed" align="center">
                      Start the conversation by leaving a comment.
                    </Text>
                  </Stack>
                </Paper>
              ) : null}
            </Stack>
          </Stack>
        )
      }
    </RootThreadProvider>
  );
}
