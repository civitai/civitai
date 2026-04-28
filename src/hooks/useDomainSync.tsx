import { showNotification } from '@mantine/notifications';
import type { SessionUser } from 'next-auth';
import { useEffect } from 'react';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { useAppContext, useServerDomains } from '~/providers/AppProvider';
import type { ColorDomain, ServerDomains } from '~/shared/constants/domain.constants';
import type { EncryptedDataSchema } from '~/server/schema/civToken.schema';

async function getSyncToken(domain: string) {
  const res = await fetch(`//${domain}/api/auth/sync`, {
    credentials: 'include',
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data as { token: EncryptedDataSchema; userId: number; username: string };
}

function hostInColor(host: string, color: ColorDomain, configs: ServerDomains): boolean {
  const cfg = configs[color];
  if (!cfg) return false;
  const normalized = host.toLowerCase();
  return cfg.primary === normalized || cfg.aliases.includes(normalized);
}

let isSyncing = false;
export function useDomainSync(currentUser: SessionUser | undefined, status: string) {
  const { swapAccount } = useAccountContext();
  const { serverDomains: serverDomainConfigs } = useAppContext();
  const serverDomains = useServerDomains();

  useEffect(() => {
    if (isSyncing || typeof window === 'undefined') return;
    const { searchParams, host, origin } = new URL(window.location.href);
    const syncColor = searchParams.get('sync-account') as ColorDomain | null;
    const syncRedirect = searchParams.get('sync-redirect');
    if (!syncColor) return;
    const syncPrimary = serverDomains[syncColor];
    // Skip if we're already on a host (primary or alias) belonging to the
    // destination color — same-color hops don't need a sync round-trip.
    if (!syncPrimary || hostInColor(host, syncColor, serverDomainConfigs) || status === 'loading')
      return;
    // Latch only once we've committed to syncing — otherwise a status='loading'
    // first render would lock the flag and never retry when the session resolves.
    isSyncing = true;

    // Only allow same-origin path redirects — reject protocol-relative or absolute URLs.
    const redirectPath =
      syncRedirect && syncRedirect.startsWith('/') && !syncRedirect.startsWith('//')
        ? syncRedirect
        : null;
    const callbackUrl = redirectPath ? `${origin}${redirectPath}` : window.location.href;

    getSyncToken(syncPrimary).then((data) => {
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
