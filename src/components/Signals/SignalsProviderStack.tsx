import { SignalNotifications } from '~/components/Signals/SignalsNotifications';
import { SignalProvider } from './SignalsProvider';
import { SignalsRegistrar } from '~/components/Signals/SignalsRegistrar';
import { SignalsDebugIndicator } from '~/components/Signals/SignalsDebugIndicator';

export function SignalsProviderStack({ children }: { children: React.ReactNode }) {
  return (
    <SignalProvider>
      <SignalNotifications />
      <SignalsRegistrar />
      <SignalsDebugIndicator />
      {children}
    </SignalProvider>
  );
}
