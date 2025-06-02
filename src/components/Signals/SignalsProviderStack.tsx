import { SignalNotifications } from '~/components/Signals/SignalsNotifications';
import { SignalProvider } from './SignalsProvider';
import { SignalsRegistrar } from '~/components/Signals/SignalsRegistrar';

export function SignalsProviderStack({ children }: { children: React.ReactNode }) {
  return (
    <SignalProvider>
      <SignalNotifications />
      <SignalsRegistrar />
      {children}
    </SignalProvider>
  );
}
