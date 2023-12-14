import { createStyles, Group, Text, Avatar, Box } from '@mantine/core';

type ConversationsMessageProps = {
  text: string;
  user: any;
};

export function ConversationsMessage(props: ConversationsMessageProps) {
  const { classes } = useStyles();

  return (
    <Group>
      {/* src, alt */}
      <Avatar
        radius="xl"
        size={45}
        imageProps={{ loading: 'lazy' }}
        sx={{ backgroundColor: 'rgba(0,0,0,0.31)' }}
      />
      <Box className={classes.messageBox}>
        <Text>{props.text}</Text>
      </Box>
    </Group>
  );
}

const useStyles = createStyles((theme) => ({
  messageBox: {
    padding: theme.spacing.md,
    marginBottom: theme.spacing.xs,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
  },
}));
