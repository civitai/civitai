import { useEffect } from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useDeviceFingerprint } from '~/providers/ActivityReportingProvider';

export function ImpressionTracker() {
  const currentUser = useCurrentUser();
  const { adsEnabled, adsBlocked } = useAdsContext();
  const { worker } = useSignalContext();
  const { fingerprint } = useDeviceFingerprint();

  useEffect(() => {
    const listener = ((e: CustomEvent) => {
      if (!adsEnabled || adsBlocked) return;

      const slot = e.detail;
      const elemId = slot.getSlotElementId();
      const outOfPage = slot.getOutOfPage();
      const elem = document.getElementById(elemId);
      const exists = !!elem;

      if (worker && exists && currentUser && !outOfPage) {
        const now = Date.now();
        const impressions = impressionsDictionary[elemId] ?? [];
        const lastImpression = impressions[impressions.length - 1];
        if (!lastImpression || now - lastImpression >= 10 * 1000) {
          impressionsDictionary[elemId] = [...impressions, now];

          worker.send('recordAdImpression', {
            userId: currentUser.id,
            fingerprint,
            adId: elemId.split('-')[0],
          });
        }
      }
    }) as EventListener;

    window.addEventListener('civitai-ad-impression', listener);
    return () => {
      window.removeEventListener('civitai-ad-impression', listener);
    };
  }, [adsEnabled, fingerprint, worker, adsBlocked, currentUser]);

  return null;
}

const impressionsDictionary: Record<string, number[]> = {};
