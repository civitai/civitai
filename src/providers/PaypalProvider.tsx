import { PayPalScriptProvider } from '@paypal/react-paypal-js';
import { env } from '~/env/client.mjs';

const initialOptions = {
  clientId: env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? '',
  currency: 'USD',
  intent: 'capture',
};

export function PaypalProvider({ children }: { children: React.ReactNode }) {
  if (!env.NEXT_PUBLIC_PAYPAL_CLIENT_ID) {
    return <>{children}</>;
  }
  return <PayPalScriptProvider options={initialOptions}>{children}</PayPalScriptProvider>;
}
