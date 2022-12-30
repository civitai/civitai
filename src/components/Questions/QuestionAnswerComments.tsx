import { Stack, Box, createStyles } from '@mantine/core';
import { Comments, CommentsProps } from '~/components/Comments/Comments.Provider';

export function QuestionAnswerComments(props: Omit<CommentsProps, 'children'>) {
  const { classes } = useStyles();
  return (
    <Stack>
      <Comments {...props}>
        <Comments.List className={classes.list} spacing={0}>
          {({ comment }) => (
            <Comments.ListItem comment={comment} px="md" className={classes.listItem} />
          )}
        </Comments.List>
        <Box px="md">
          <Comments.More />
          <Comments.AddComment />
        </Box>
      </Comments>
    </Stack>
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
