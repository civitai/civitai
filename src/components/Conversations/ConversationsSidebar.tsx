import { useState, useEffect } from 'react';
import { serviceClient } from '~/utils/trpc';
import Link from 'next/link';

export function ConversationsSidebar() {
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
    <div>
      <div>
        <button onClick={handleNewConversation}>New Conversation</button>
      </div>
      {/* TODO: Scrollable container */}
      <div>
        {loading ? (
          <div>Loading...</div>
        ) : (
          conversations?.map((conversation) => (
            <div key={conversation.id}>
              <Link href={`/conversations/${conversation.id}`}>{conversation.name}</Link>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
