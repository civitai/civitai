import { showNotification } from '@mantine/notifications';
import { SessionUser } from 'next-auth';
import { useEffect } from 'react';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { env } from '~/env/client.mjs';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { EncryptedDataSchema } from '~/server/schema/civToken.schema';

const syncDomains = {
  green: env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN,
  blue: env.NEXT_PUBLIC_SERVER_DOMAIN_BLUE,
  red: env.NEXT_PUBLIC_SERVER_DOMAIN_RED,
};
type SyncDomain = keyof typeof syncDomains;

async function getSyncToken(syncAccount: SyncDomain = 'blue') {
  const domain = syncDomains[syncAccount];
  const res = await fetch(`//${domain}/api/auth/sync`, {
    credentials: 'include',
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data as { token: EncryptedDataSchema; userId: number; username: string; };
}

let isSyncing = false;
export function useDomainSync(currentUser: SessionUser | undefined) {
  const { swapAccount } = useAccountContext();

  useEffect(() => {
    if (isSyncing || typeof window === 'undefined') return;
    isSyncing = true;
    const { searchParams, host } = new URL(window.location.href);
    const syncColor = searchParams.get('sync-account') as SyncDomain | null;
    if (!syncColor) return;
    const syncDomain = syncDomains[syncColor];
    if (!syncDomain || host === syncDomain) return;

    getSyncToken(syncColor).then((data) => {
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
      setTimeout(() => {
        swapAccount(token).catch(() => {});
      }, 1000);
    });
  }, []);
}
