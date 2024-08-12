import { CheckoutEventsData, initializePaddle, Paddle, PaddleEventData } from '@paddle/paddle-js';
import { useContext, useEffect, useState, createContext, useRef, useCallback } from 'react';
import { env } from '~/env/client.mjs';
import { EventEmitter } from '~/utils/eventEmitter';

type PaddleEventEmitter = {
  'checkout.completed': CheckoutEventsData | undefined;
};

const PaddleContext = createContext<
  | {
      paddle: Paddle;
      emitter: EventEmitter<PaddleEventEmitter>;
    }
  | undefined
>(undefined);
export const usePaddle = () => {
  const context = useContext(PaddleContext);
  if (!context) throw new Error('Could not initialize paddle');
  return context;
};

export function PaddleProvider({ children }: { children: React.ReactNode }) {
  const [paddle, setPaddle] = useState<Paddle>();
  const emitter = useRef<EventEmitter<{ 'checkout.completed': CheckoutEventsData | undefined }>>();
  const eventCallback = useCallback(
    (e: PaddleEventData) => {
      // console.log(e);
      if (e.name === 'checkout.completed') {
        // console.log('checkout completed', e.data, emitter.current);
        emitter.current?.emit(e.name, e.data);
      }
    },
    [emitter]
  );

  // Download and initialize Paddle instance from CDN
  useEffect(() => {
    if (env.NEXT_PUBLIC_PADDLE_TOKEN) {
      emitter.current = new EventEmitter<{
        'checkout.completed': CheckoutEventsData | undefined;
      }>();
      initializePaddle({
        environment: 'sandbox',
        token: env.NEXT_PUBLIC_PADDLE_TOKEN,
        eventCallback,
      }).then((paddleInstance: Paddle | undefined) => {
        if (paddleInstance) {
          setPaddle(paddleInstance);
        }
      });
    }
  }, []);

  return (
    <PaddleContext.Provider
      value={{
        paddle: paddle as Paddle,
        emitter: emitter.current as EventEmitter<PaddleEventEmitter>,
      }}
    >
      {children}
    </PaddleContext.Provider>
  );
}
