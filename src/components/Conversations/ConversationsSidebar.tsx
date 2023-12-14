import { useState, useEffect } from 'react';
import { serviceClient } from '~/utils/trpc';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Button, Group, Loader, NavLink, Text, createStyles } from '@mantine/core';

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

  const handleNewConversation = async () => {
    const data = await serviceClient.conversations.createConversation.mutate({
      name: 'New convo',
      users: [],
    });
    setConversations((prev: any) => [...prev, data]);
  };

  // TODO: State: loading, conversations, empty
  return (
    <>
      <Link href="/conversations/new">
        <Button>New Conversation</Button>
      </Link>
      {/* TODO: Scrollable container */}
      <div>
        {loading ? (
          <Loader size="sm" />
        ) : (
          // router.query.conversationId
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
      </div>
    </>
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
