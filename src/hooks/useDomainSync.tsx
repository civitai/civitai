import { showNotification } from '@mantine/notifications';
import type { SessionUser } from 'next-auth';
import { useEffect } from 'react';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { env } from '~/env/client';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ColorDomain } from '~/server/common/constants';
import { colorDomains } from '~/server/common/constants';
import type { EncryptedDataSchema } from '~/server/schema/civToken.schema';

async function getSyncToken(syncAccount: ColorDomain = 'blue') {
  const domain = colorDomains[syncAccount];
  const res = await fetch(`//${domain}/api/auth/sync`, {
    credentials: 'include',
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data as { token: EncryptedDataSchema; userId: number; username: string };
}

let isSyncing = false;
export function useDomainSync(currentUser: SessionUser | undefined, status: string) {
  const { swapAccount } = useAccountContext();

  useEffect(() => {
    if (isSyncing || typeof window === 'undefined') return;
    isSyncing = true;
    const { searchParams, host } = new URL(window.location.href);
    const syncColor = searchParams.get('sync-account') as ColorDomain | null;
    if (!syncColor) return;
    const syncDomain = colorDomains[syncColor];
    if (!syncDomain || host === syncDomain || status === 'loading') return;

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
  }, [status]);
}
