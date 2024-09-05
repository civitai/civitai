import { useEffect } from 'react';
import { create } from 'zustand';
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
      const elemId = e.detail.elemId;
      const elem = document.getElementById(elemId);
      const exists = !!elem;

      console.log({ ...e.detail, exists });

      if (worker && exists && currentUser) {
        const adId = elemId.split('-')[0];
        const impressions = impressionsDictionary[adId];
        const lastIndex = impressions.length - 1;
        const now = Date.now();

        worker.send('recordAdImpression', {
          userId: currentUser.id,
          fingerprint,
          adId,
        });
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

type ImpressionStore = Record<string, number[]>;
const useImpressionStore = create<ImpressionStore>(() => ({}));
