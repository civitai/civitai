import ConversationsLayout from '~/components/Conversations/ConversationsLayout';
import { serviceClient } from '~/utils/trpc';
import { TextInput, Group, Button, Badge, ActionIcon } from '@mantine/core';
import { IconSend, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { useRouter } from 'next/router';
import { UserSearchDropdown } from '~/components/Conversations/ConversationsUserSearch';
import { UserWithCosmetics } from '~/server/selectors/user.selector';

export default function ConversationsNewPage() {
  const { push } = useRouter();
  const [text, setText] = useState<null | string>(null);
  const [title, setTitle] = useState<null | string>(null);
  const [users, setUsers] = useState<Partial<UserWithCosmetics>[]>([]);

  // TODO: Error handling
  const handleNewConversation = async () => {
    const data = await serviceClient.conversations.createConversation.mutate({
      name: title || users.map((user) => user.username).join(', '),
      users: users.map((user) => user.id || 0),
    });

    if (text) {
      await serviceClient.messages.createMessage.mutate({
        conversationId: data.id,
        text: text || '',
      });
    }

    push(`/conversations/${data.id}`);
  };

  const handleRemoveUser = (user: Partial<UserWithCosmetics>) => {
    setUsers((prev) => prev.filter((u) => u.id !== user.id));
  };

  const removeButton = (
    <ActionIcon size="xs" variant="transparent">
      <IconX size={10} />
    </ActionIcon>
  );

  return (
    <ConversationsLayout>
      <UserSearchDropdown onItemSelected={(item) => setUsers((prev) => [...prev, item])} />
      <Group my={50}>
        {users.map((user) => (
          <Badge
            color="gray"
            onClick={() => handleRemoveUser(user)}
            key={user.id}
            rightSection={removeButton}
          >
            {user.username}
          </Badge>
        ))}
      </Group>
      <Group>
        <TextInput placeholder="Set title" onChange={(event) => setTitle(event.target.value)} />
      </Group>
      <p>Welcome to chat!</p>
      <p>
        Search for others in the community to start a conversation with above and send your first
        message.
      </p>
      <Group grow>
        <TextInput
          placeholder="Type a message..."
          onChange={(event) => setText(event.target.value)}
        />
        <div>
          <Button
            rightIcon={<IconSend size={14} />}
            variant="default"
            onClick={handleNewConversation}
            disabled={!text}
          >
            Send
          </Button>
        </div>
      </Group>
    </ConversationsLayout>
  );
}
