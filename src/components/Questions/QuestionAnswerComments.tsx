import { Stack, Box, createStyles, Group, Text, Center, Loader } from '@mantine/core';
import { CommentsProvider, LoadNextPage, CreateComment, Comment } from '~/components/CommentsV2';
import { InfiniteCommentResults } from '~/server/controllers/commentv2.controller';
import { CommentConnectorInput } from '~/server/schema/commentv2.schema';

type CommentsResult = InfiniteCommentResults['comments'];
type Props = CommentConnectorInput & {
  initialData?: CommentsResult;
  initialLimit?: number;
  initialCount?: number;
  limit?: number;
  userId: number;
};
export function QuestionAnswerComments({
  initialData,
  initialLimit = 4,
  initialCount,
  limit,
  userId,
  entityId,
  entityType,
}: Props) {
  const { classes } = useStyles();

  return (
    <CommentsProvider
      initialCount={initialCount}
      initialData={initialData}
      initialLimit={initialLimit}
      limit={limit}
      badges={[{ label: 'op', color: 'violet', userId }]}
      entityId={entityId}
      entityType={entityType}
    >
      {({ data, created, isInitialLoading, isFetching, hasNextPage }) =>
        isInitialLoading ? (
          <Center>
            <Loader variant="bars" />
          </Center>
        ) : (
          <Box className={classes.list}>
            {data?.map((comment) => (
              <Comment key={comment.id} comment={comment} className={classes.listItem} />
            ))}
            <LoadNextPage>
              {({ remaining, onClick }) => (
                <Group spacing="xs" align="center" p="sm" pb={0}>
                  {isFetching && <Loader size="xs" />}
                  <Text variant="link" sx={{ cursor: 'pointer' }} onClick={onClick}>
                    {remaining > 0
                      ? `Show ${remaining} more ${remaining > 1 ? 'comments' : 'comment'}`
                      : 'Show more'}
                  </Text>
                </Group>
              )}
            </LoadNextPage>
            {created.map((comment) => (
              <Comment key={comment.id} comment={comment} className={classes.listItem} />
            ))}
            {!hasNextPage && (
              <Box p="sm" pb={0}>
                <CreateComment />
              </Box>
            )}
          </Box>
        )
      }
    </CommentsProvider>
  );
}

const useStyles = createStyles((theme) => {
  const borderColor = theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3];
  return {
    list: {
      borderTop: `1px solid ${borderColor}`,
    },
    listItem: {
      padding: theme.spacing.sm,
      borderBottom: `1px solid ${borderColor}`,
    },
  };
});
