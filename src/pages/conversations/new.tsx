import ConversationsLayout from '~/components/Conversations/ConversationsLayout';
import { serviceClient } from '~/utils/trpc';
import { TextInput, Group, Button } from '@mantine/core';
import { IconSend } from '@tabler/icons-react';
import { useState } from 'react';
import { useRouter } from 'next/router';

/**
 * TODO:
 * - Search and add users
 * - Send message
 * - Creates new conversation and redirects to conversationId
 */
export default function ConversationsNewPage() {
  const { push } = useRouter();
  const [text, setText] = useState<null | string>(null);
  const [title, setTitle] = useState<null | string>(null);

  // TODO: Error handling
  const handleNewConversation = async () => {
    const data = await serviceClient.conversations.createConversation.mutate({
      name: title || 'New conversation', // TODO: Use usernames instead
      users: [],
    });

    const message = await serviceClient.messages.createMessage.mutate({
      conversationId: data.id,
      text: text || '',
    });

    push(`/conversations/${data.id}`);
  };

  return (
    <ConversationsLayout>
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
