import { initializePaddle, Paddle } from '@paddle/paddle-js';
import { useContext, useEffect, useState, createContext } from 'react';
import { env } from '~/env/client.mjs';

const PaddleContext = createContext<Paddle | undefined>(undefined);
export const usePaddle = () => {
  const context = useContext(PaddleContext);
  if (!context) throw new Error('Could not initialize paddle');
  return context;
};

export function PaypalProvider({ children }: { children: React.ReactNode }) {
  const [paddle, setPaddle] = useState<Paddle>();

  // Download and initialize Paddle instance from CDN
  useEffect(() => {
    if (env.NEXT_PUBLIC_PADDLE_TOKEN) {
      initializePaddle({ environment: 'sandbox', token: env.NEXT_PUBLIC_PADDLE_TOKEN }).then(
        (paddleInstance: Paddle | undefined) => {
          if (paddleInstance) {
            setPaddle(paddleInstance);
          }
        }
      );
    }
  }, []);

  return <PaddleContext.Provider value={paddle}>{children}</PaddleContext.Provider>;
}
