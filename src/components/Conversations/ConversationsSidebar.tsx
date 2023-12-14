import { useState, useEffect } from 'react';
import { serviceClient } from '~/utils/trpc';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  Button,
  Group,
  Loader,
  NavLink,
  Navbar,
  ScrollArea,
  Text,
  createStyles,
} from '@mantine/core';

export function ConversationsSidebar() {
  const router = useRouter();
  const { classes } = useStyles();
  const [conversations, setConversations] = useState<any>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchConversations = async () => {
      setLoading(true);
      const data = await serviceClient.conversations.getConversations.query({ first: 3 });
      setConversations(data);
      setLoading(false);

      return data;
    };

    fetchConversations();
  }, []);

  return (
    <Navbar p="md" hiddenBreakpoint="sm" width={{ sm: 200, lg: 300 }}>
      <Navbar.Section my="xs">
        <Link href="/conversations/new">
          <Button>New Conversation</Button>
        </Link>
      </Navbar.Section>
      <Navbar.Section grow component={ScrollArea} mx="-xs" px="xs">
        {loading ? (
          <Loader size="sm" />
        ) : (
          conversations?.map((conversation) => (
            <Link href={`/conversations/${conversation.id}`} key={conversation.id}>
              <NavLink
                className={classes.navItem}
                active={router.query.conversationId === conversation.id}
                label={
                  <Group position="apart">
                    <Text weight={500}>{conversation.name}</Text>
                  </Group>
                }
              />
            </Link>
          ))
        )}
      </Navbar.Section>
    </Navbar>
  );
}

const useStyles = createStyles((theme) => ({
  navItem: {
    borderRight: `1px solid ${theme.colors.gray[theme.colorScheme === 'dark' ? 9 : 2]}`,
    '&[data-active="true"]': {
      borderRightColor: theme.colors.blue[theme.colorScheme === 'dark' ? 9 : 2],
    },
  },
}));
