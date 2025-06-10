import { useLocalStorage } from '@mantine/hooks';
import { getCurrentBrowserFingerPrint } from '@rajesh896/broprint.js';
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsTabActive } from '~/hooks/useIsTabActive';
import { trpc } from '~/utils/trpc';

const SEND_INTERVAL = 10000;
const activities: string[] = [];
async function sendActivities() {
  if (activities.length) {
    await fetch('/api/internal/activity', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ activities }),
    });
    activities.length = 0;
  }
  setTimeout(sendActivities, SEND_INTERVAL);
}

let initialized = false;
function init() {
  // Only run on client
  if (typeof window === 'undefined') return;
  // Only run once
  if (initialized) return;

  document.addEventListener(
    'click',
    (e) => {
      // Scan self and parent for data-activity="..." attribute
      let el = e.target as HTMLElement | null;
      while (el) {
        if (el.dataset.activity) {
          activities.push(el.dataset.activity);
          return;
        }
        el = el.parentElement;
      }
    },
    true // Capture phase
  );

  sendActivities();
  initialized = true;
}

const ActivityReportingContext = createContext<{ fingerprint?: string; anotherTabOpen?: boolean }>(
  {}
);
export const useDeviceFingerprint = () => {
  const context = useContext(ActivityReportingContext);
  if (!context)
    throw new Error('useDeviceFingerprint must be used within a ActivityReportingProvider');

  return context;
};

export function ActivityReportingProvider({ children }: { children: ReactNode }) {
  const currentUser = useCurrentUser();
  // To keep the fingerprint in sync with the local storage
  const [fingerprint, setFingerprint] = useLocalStorage<string | undefined>({
    key: 'fingerprint',
    defaultValue: undefined,
  });
  const anotherTabOpen = useIsTabActive();

  const computeFingerprintMutation = trpc.user.ingestFingerprint.useMutation({
    onSuccess(result) {
      setFingerprint(result);
    },
  });

  useEffect(() => {
    // Use window to get the current stored value of fingerprint without delay
    const localFingerprint = window.localStorage.getItem('fingerprint');
    if (localFingerprint || !currentUser?.id || computeFingerprintMutation.isLoading) return;

    getCurrentBrowserFingerPrint().then((fingerprint) => {
      computeFingerprintMutation.mutate({ fingerprint: fingerprint.toString() });
    });
  }, [currentUser?.id, computeFingerprintMutation.isLoading, fingerprint]);

  init();

  return (
    <ActivityReportingContext.Provider value={{ fingerprint, anotherTabOpen }}>
      {children}
    </ActivityReportingContext.Provider>
  );
}
