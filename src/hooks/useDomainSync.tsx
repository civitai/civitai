import { showNotification } from '@mantine/notifications';
import type { SessionUser } from 'next-auth';
import { useEffect } from 'react';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { useServerDomains } from '~/providers/AppProvider';
import type { ColorDomain, ServerDomains } from '~/shared/constants/domain.constants';
import type { EncryptedDataSchema } from '~/server/schema/civToken.schema';

async function getSyncToken(serverDomains: ServerDomains, syncAccount: ColorDomain = 'blue') {
  const domain = serverDomains[syncAccount];
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
  const serverDomains = useServerDomains();

  useEffect(() => {
    if (isSyncing || typeof window === 'undefined') return;
    const { searchParams, host, origin } = new URL(window.location.href);
    const syncColor = searchParams.get('sync-account') as ColorDomain | null;
    const syncRedirect = searchParams.get('sync-redirect');
    if (!syncColor) return;
    const syncDomain = serverDomains[syncColor];
    if (!syncDomain || host === syncDomain || status === 'loading') return;
    // Latch only once we've committed to syncing — otherwise a status='loading'
    // first render would lock the flag and never retry when the session resolves.
    isSyncing = true;

    // Only allow same-origin path redirects — reject protocol-relative or absolute URLs.
    const redirectPath =
      syncRedirect && syncRedirect.startsWith('/') && !syncRedirect.startsWith('//')
        ? syncRedirect
        : null;
    const callbackUrl = redirectPath ? `${origin}${redirectPath}` : window.location.href;

    getSyncToken(serverDomains, syncColor).then((data) => {
      if (!data) {
        if (redirectPath) window.location.replace(callbackUrl);
        return;
      }
      const { token, userId, username } = data;
      if (currentUser?.id === userId) {
        if (redirectPath) window.location.replace(callbackUrl);
        return;
      }
      showNotification({
        id: 'domain-sync',
        loading: true,
        autoClose: false,
        title: 'Syncing account...',
        message: `Switching to ${username} account`,
      });
      setTimeout(() => {
        swapAccount(token, callbackUrl).catch(() => undefined);
      }, 1000);
    });
  }, [status]);
}
