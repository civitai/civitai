import { useEffect } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import dynamic from 'next/dynamic';
import { useIsRegionRestricted } from '~/hooks/useIsRegionRestricted';

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

  useEffect(() => {
    // Only proceed if the current region is actually restricted
    if (!isRestricted) return;

    // Check if we were redirected from the main domain due to region restrictions
    const urlParams = new URLSearchParams(window.location.search);
    const redirectParam = urlParams.get('region-redirect');

    // Check localStorage to see if we've already shown this modal before
    const storageKey = 'region-redirect-modal-shown';
    const hasSeenModal = localStorage.getItem(storageKey);

    if (redirectParam === 'true' || document.referrer.includes('civitai.com')) {
      // Only show modal if the user hasn't seen it before
      if (!hasSeenModal) {
        dialogStore.trigger({
          id: 'region-redirect',
          component: RegionRedirectModal,
          props: { storageKey },
        });
      }
    }
  }, [isRestricted]);
}
