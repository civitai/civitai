import { Box, createStyles, Group, Text, Center, Loader } from '@mantine/core';
import { CommentsProvider, CreateComment, Comment } from '~/components/CommentsV2';
import { CommentConnectorInput } from '~/server/schema/commentv2.schema';

type Props = CommentConnectorInput & {
  initialCount?: number;
  limit?: number;
  userId: number;
};
export function QuestionAnswerComments({
  limit,
  userId,
  entityId,
  entityType,
  initialCount,
}: Props) {
  const { classes } = useStyles();

  return (
    <CommentsProvider
      limit={limit}
      initialCount={initialCount}
      badges={[{ label: 'op', color: 'violet', userId }]}
      entityId={entityId}
      entityType={entityType}
    >
      {({ data, created, isLoading, remaining, showMore, toggleShowMore }) =>
        isLoading ? (
          <Center>
            <Loader variant="bars" />
          </Center>
        ) : (
          <Box className={classes.list}>
            {data?.map((comment) => (
              <Comment key={comment.id} comment={comment} className={classes.listItem} />
            ))}

            {!!remaining && !showMore && (
              <Group spacing="xs" align="center" p="sm" pb={0}>
                <Text variant="link" sx={{ cursor: 'pointer' }} onClick={toggleShowMore}>
                  Show {remaining} More
                </Text>
              </Group>
            )}
            {created.map((comment) => (
              <Comment key={comment.id} comment={comment} className={classes.listItem} />
            ))}
            {!remaining && (
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
