import { useEffect, useMemo } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import dynamic from 'next/dynamic';
import { useIsRegionRestricted } from '~/hooks/useIsRegionRestricted';
import { useServerDomains } from '~/providers/AppProvider';

const RegionRedirectModal = dynamic(
  () => import('~/components/RegionRedirect/RegionRedirectModal'),
  { ssr: false }
);

/**
 * Hook to detect if the user was redirected due to region restrictions
 * Automatically triggers the RegionRedirectModal when appropriate
 */
export function useRegionRedirectDetection() {
  const { isRestricted } = useIsRegionRestricted();
  const serverDomains = useServerDomains();
  const otherDomains = useMemo(
    () => [serverDomains.blue, serverDomains.red].filter(Boolean) as string[],
    [serverDomains.blue, serverDomains.red]
  );

  useEffect(() => {
    // Check localStorage to see if we've already shown this modal before
    const storageKey = 'region-redirect-modal-shown';
    const hasSeenModal = localStorage.getItem(storageKey);
    // Only proceed if the current region is actually restricted or if the user hasn't seen it before
    if (!isRestricted || hasSeenModal) return;

    // Check if we were redirected from the main domain due to region restrictions
    const urlParams = new URLSearchParams(window.location.search);
    const redirectParam = urlParams.get('region-redirect');

    // Check if referrer is from other servers (excluding green/main domain)
    const isFromOtherServer = otherDomains.some((domain) => document.referrer.includes(domain));

    if (redirectParam === 'true' || isFromOtherServer) {
      dialogStore.trigger({
        id: 'region-redirect',
        component: RegionRedirectModal,
        props: { storageKey },
      });
    }
  }, [isRestricted, otherDomains]);
}
