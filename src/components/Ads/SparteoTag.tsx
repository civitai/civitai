import { useEffect, useState } from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import {
  SPARTEO_TAG_SRC,
  SPARTEO_TCF,
  type SparteoTcfRequirements,
} from '~/components/Ads/sparteo.config';
import { useThirdPartyConsent } from '~/components/Consent/consent.context';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export const SPARTEO_TAG_ID = 'sparteo-tag';

declare global {
  interface Window {
    _hbdbrk?: unknown[];
  }
}

type TcfConsents = {
  consents?: Record<number, boolean>;
  legitimateInterests?: Record<number, boolean>;
};
type TcData = {
  eventStatus?: string;
  gdprApplies?: boolean;
  listenerId?: number;
  purpose?: TcfConsents;
  vendor?: TcfConsents;
};

/** `success` only means the CMP call worked, so the visitor's choice is read from the purposes. */
export function tcfAllowsTag(tcData: TcData | null | undefined, tcf: SparteoTcfRequirements) {
  if (!tcData || !['tcloaded', 'useractioncomplete'].includes(tcData.eventStatus ?? ''))
    return false;
  if (tcData.gdprApplies === false) return true;
  const { purpose, vendor } = tcData;
  if (vendor?.consents?.[tcf.vendorId] !== true) return false;
  if (!tcf.consentPurposes.every((p) => purpose?.consents?.[p] === true)) return false;
  return tcf.legIntPurposes.every(
    (p) =>
      purpose?.consents?.[p] === true ||
      (purpose?.legitimateInterests?.[p] === true &&
        vendor?.legitimateInterests?.[tcf.vendorId] === true)
  );
}

function useTcfAllowsTag(active: boolean) {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (!active || typeof window.__tcfapi !== 'function') return;
    let listenerId: number | undefined;
    window.__tcfapi('addEventListener', 2, (tcData: TcData, success: boolean) => {
      listenerId = tcData?.listenerId;
      setAllowed(success && tcfAllowsTag(tcData, SPARTEO_TCF));
    });
    return () => {
      if (listenerId !== undefined)
        window.__tcfapi('removeEventListener', 2, () => undefined, listenerId);
    };
  }, [active]);

  return active && allowed;
}

export function SparteoTag() {
  const { adsEnabled, useDirectAds, ready } = useAdsContext();
  const { allowed: consentAllowed } = useThirdPartyConsent();
  const features = useFeatureFlags();
  const src = SPARTEO_TAG_SRC;
  // `ready`: the CMP that Snigel's loader brings has answered, so `__tcfapi` exists.
  const gated = !!features.sparteoAds && adsEnabled && ready && !useDirectAds && consentAllowed;
  const tcfAllowed = useTcfAllowsTag(gated);
  const enabled = gated && tcfAllowed;

  useEffect(() => {
    if (!enabled || !src || document.getElementById(SPARTEO_TAG_ID)) return;
    // The partner's tag declares this queue inline before its loader runs.
    window._hbdbrk = window._hbdbrk || [];
    const script = document.createElement('script');
    script.id = SPARTEO_TAG_ID;
    script.async = true;
    script.setAttribute('data-cfasync', 'false');
    script.src = src;
    document.head.appendChild(script);
  }, [enabled, src]);

  return null;
}
