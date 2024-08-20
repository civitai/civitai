import { useLocalStorage } from '@mantine/hooks';
import { getCurrentBrowserFingerPrint } from '@rajesh896/broprint.js';
import { useEffect, useRef } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export function useDeviceFingerprint() {
  const currentUser = useCurrentUser();
  const mounted = useRef(false);
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
    if (fingerprint || !currentUser || !mounted.current) {
      mounted.current = true;
      return;
    }

    getCurrentBrowserFingerPrint().then((fingerprint) => {
      computeFingerprintMutation.mutate({ fingerprint: fingerprint.toString() });
    });
  }, [currentUser, fingerprint]);

  return { fingerprint, loading: computeFingerprintMutation.isLoading };
}
