import { Stack, Group, Text, Loader, Center, Divider, Paper } from '@mantine/core';
import { CommentsProvider, CreateComment, Comment } from '~/components/CommentsV2';

type Props = {
  bountyId: number;
  userId?: number;
};

export function BountyDiscussion({ bountyId, userId }: Props) {
  return (
    <CommentsProvider
      entityType="bounty"
      entityId={bountyId}
      limit={20}
      badges={userId ? [{ userId, label: 'op', color: 'violet' }] : []}
    >
      {({ data, created, isLoading, remaining, showMore, toggleShowMore }) =>
        isLoading ? (
          <Center>
            <Loader variant="bars" />
          </Center>
        ) : (
          <Stack>
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
            ) : (
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
            )}
          </Stack>
        )
      }
    </CommentsProvider>
  );
}
