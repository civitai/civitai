import { createStyles, Group, Text, Box } from '@mantine/core';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { UserWithCosmetics } from '~/server/selectors/user.selector';

type ConversationsMessageProps = {
  text: string;
  sender: Partial<UserWithCosmetics>;
};

export function ConversationsMessage(props: ConversationsMessageProps) {
  const { classes, cx } = useStyles();
  const currentUser = useCurrentUser();
  const isCurrentUser = currentUser?.id === props.sender.id;

  return (
    <Group
      className={cx(classes.messageGroup, {
        [classes.messageGroupIsUser]: isCurrentUser,
      })}
    >
      <UserAvatar user={props.sender} size="md" />
      <Box
        className={cx(classes.messageBox, {
          [classes.messageBoxIsUser]: isCurrentUser,
        })}
      >
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
  messageBoxIsUser: {
    color: 'white',
    backgroundColor: theme.colors.blue[6],
  },
  messageGroup: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
  },
  messageGroupIsUser: {
    flexDirection: 'row-reverse',
  },
}));
