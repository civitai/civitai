import { useEffect } from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { SPARTEO_TAG_SRC } from '~/components/Ads/sparteo.config';
import { useThirdPartyConsent } from '~/components/Consent/consent.context';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export const SPARTEO_TAG_ID = 'sparteo-tag';

export function SparteoTag() {
  const { adsEnabled, useDirectAds, ready } = useAdsContext();
  const { allowed: consentAllowed } = useThirdPartyConsent();
  const features = useFeatureFlags();
  const src = SPARTEO_TAG_SRC;
  // `ready`: the TCF prompt has finished, which is what Snigel's ad calls wait for outside CA.
  // TODO: once Sparteo's tag is in hand, confirm it reads the TCF purposes itself before bidding.
  const enabled = !!features.sparteoAds && adsEnabled && ready && !useDirectAds && consentAllowed;

  useEffect(() => {
    if (!enabled || !src || document.getElementById(SPARTEO_TAG_ID)) return;
    const script = document.createElement('script');
    script.id = SPARTEO_TAG_ID;
    script.async = true;
    script.src = src;
    document.head.appendChild(script);
  }, [enabled, src]);

  return null;
}
