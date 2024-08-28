import { useLocalStorage } from '@mantine/hooks';
import { getCurrentBrowserFingerPrint } from '@rajesh896/broprint.js';
import { useEffect } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export function useDeviceFingerprint() {
  const currentUser = useCurrentUser();
  // To keep the fingerprint in sync with the local storage
  const [fingerprint, setFingerprint] = useLocalStorage<string | undefined>({
    key: 'fingerprint',
    defaultValue: undefined,
  });

  const computeFingerprintMutation = trpc.user.computeFingerprint.useMutation({
    onSuccess(result) {
      setFingerprint(result);
    },
  });

  useEffect(() => {
    // Use window to get the current stored value of fingerprint without delay
    const localFingerprint = window.localStorage.getItem('fingerprint');
    if (localFingerprint || !currentUser || computeFingerprintMutation.isLoading) return;

    getCurrentBrowserFingerPrint().then((fingerprint) => {
      computeFingerprintMutation.mutate({ fingerprint: fingerprint.toString() });
    });
  }, [currentUser, computeFingerprintMutation.isLoading]);

  return { fingerprint, loading: computeFingerprintMutation.isLoading };
}
