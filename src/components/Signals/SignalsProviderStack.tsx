import { SignalNotifications } from '~/components/Signals/SignalsNotifications';
import { SignalProvider } from './SignalsProvider';
import { SignalsRegistrar } from '~/components/Signals/SignalsRegistrar';
import { SignalsDebugIndicator } from '~/components/Signals/SignalsDebugIndicator';
import dynamic from 'next/dynamic';

const EventPointsSelfPops = dynamic(
  () => import('~/components/HatTurf/EventPointsSelfPops').then((m) => m.EventPointsSelfPops),
  { ssr: false }
);

export function SignalsProviderStack({ children }: { children: React.ReactNode }) {
  return (
    <SignalProvider>
      <SignalNotifications />
      <SignalsRegistrar />
      <SignalsDebugIndicator />
      <EventPointsSelfPops />
      {children}
    </SignalProvider>
  );
}
