import { useState, useEffect } from 'react';

export const useIsTabActive = () => {
  const [anotherTabOpen, setAnotherTabOpen] = useState(false);

  useEffect(() => {
    const channel = new BroadcastChannel('app_presence_channel');
    let hasReceivedPong = false;

    const handleMessage = (event: MessageEvent) => {
      const { type } = event.data;
      if (type === 'PING') {
        channel.postMessage({ type: 'PONG' });
      } else if (type === 'PONG') {
        hasReceivedPong = true;
        setAnotherTabOpen(true);
      }
    };

    channel.addEventListener('message', handleMessage);

    // Send out a ping
    channel.postMessage({ type: 'PING' });

    // If no response in 1 second, assume no other tab is open
    const timeout = setTimeout(() => {
      if (!hasReceivedPong) setAnotherTabOpen(false);
    }, 1000);

    return () => {
      clearTimeout(timeout);
      channel.removeEventListener('message', handleMessage);
      channel.close();
    };
  }, []);

  return anotherTabOpen;
};
