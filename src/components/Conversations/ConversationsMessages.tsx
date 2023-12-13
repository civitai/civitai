import { useRouter } from 'next/router';
import { useState, useEffect } from 'react';
import { serviceClient } from '~/utils/trpc';

export function ConversationMessages() {
  const router = useRouter();
  const [messages, setMessages] = useState<any>([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState<null | string>(null);

  // TODO: Instead this should be a messages w/ pagination
  useEffect(() => {
    const fetchConversations = async () => {
      setLoading(true);
      // TODO: Replace this id with param from route
      const data = await serviceClient.messages.getMessagesByConversationId.query({
        conversationId: router.query.conversationId || '',
        first: 10,
      });

      setMessages(data.reverse());
      setLoading(false);

      return data;
    };

    fetchConversations();
  }, [router.query.conversationId]);

  const handleNewMessage = async () => {
    if (!text) return;

    const data = await serviceClient.messages.createMessage.mutate({
      text: text,
      conversationId: router.query.conversationId || '',
    });

    setMessages((prev: any) => {
      return [...prev, data];
    });
    setText(null);
  };

  return (
    <div>
      {loading ? (
        <div>Loading...</div>
      ) : (
        <div>
          {messages?.map((message, i) => (
            <div key={i}>
              {message.text} {i}
            </div>
          ))}
        </div>
      )}
      <div>
        <input placeholder="Type a message..." onChange={(event) => setText(event.target.value)} />
        <button onClick={handleNewMessage} disabled={!text}>
          Submit
        </button>
      </div>
    </div>
  );
}
