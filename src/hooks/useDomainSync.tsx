import { showNotification } from '@mantine/notifications';
import { SessionUser } from 'next-auth';
import { useEffect } from 'react';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { env } from '~/env/client.mjs';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { EncryptedDataSchema } from '~/server/schema/civToken.schema';

async function getSyncToken() {
  const res = await fetch(`//${env.NEXT_PUBLIC_SERVER_DOMAIN_BLUE}/api/auth/sync`, {
    credentials: 'include',
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data as { token: EncryptedDataSchema; userId: number; username: string; };
}

let isSyncing = false;
export function useDomainSync(currentUser: SessionUser | undefined) {
  const { swapAccount } = useAccountContext();
  const { isBlue } = useFeatureFlags();

  useEffect(() => {
    if (isBlue) return;
    if (isSyncing) return;
    isSyncing = true;
    getSyncToken().then((data) => {
      if (!data) return;
      const { token, userId, username } = data;
      if (currentUser?.id === userId) return;
      showNotification({
        id: 'domain-sync',
        loading: true,
        autoClose: false,
        title: 'Syncing account...',
        message: `Switching to ${username} account`,
      });
      swapAccount(token).catch(() => {});
    });
  }, []);
}
