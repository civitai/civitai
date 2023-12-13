import { set } from 'lodash';
import { useState, useEffect } from 'react';
import { serviceClient } from '~/utils/trpc';

export function ConversationMessages() {
  const [messages, setMessages] = useState<any>([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState<null | string>(null);

  // TODO: Instead this should be a messages w/ pagination
  const fetchConversations = async () => {
    setLoading(true);
    // TODO: Replace this id with param from route
    const data = await serviceClient.messages.getMessagesByConversationId.query({
      conversationId: '5468a60c-d78f-4021-9726-1f07b003cb9b',
      first: 10,
    });

    setMessages(data.reverse());
    setLoading(false);

    return data;
  };

  useEffect(() => {
    (async () => fetchConversations())();
  }, []);

  const handleNewMessage = async () => {
    if (!text) return;

    const data = await serviceClient.messages.createMessage.mutate({
      text: text,
      conversationId: '5468a60c-d78f-4021-9726-1f07b003cb9b',
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
