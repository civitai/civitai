import Script from 'next/script';
import { useEffect, useState } from 'react';

/** Sparteo's IAB TCF vendor id (Global Vendor List, checked at GVL v186). */
export const SPARTEO_TCF_VENDOR_ID = 1028;

const SPARTEO_TAG_SRC = 'https://www.flashb.id/universal/f812656a-2eb5-5363-b9fb-90c27d71eb79.js';

/** How long to wait for a CMP to install `__tcfapi` before giving up (and not loading). */
const CMP_WAIT_MS = 30_000;
const CMP_POLL_MS = 250;

type TcData = {
  eventStatus?: string;
  gdprApplies?: boolean;
  listenerId?: number;
  vendor?: { consents?: Record<string, boolean> };
};

/**
 * Whether a TCF `addEventListener` callback lets `vendorId` run: `null` while the CMP has not
 * settled (stub, UI still showing), so the caller keeps waiting.
 */
export function tcfAllowsVendor(
  tcData: TcData | null | undefined,
  success: boolean,
  vendorId: number
): boolean | null {
  if (!success || !tcData) return null;
  if (tcData.eventStatus !== 'tcloaded' && tcData.eventStatus !== 'useractioncomplete') return null;
  if (tcData.gdprApplies === false) return true;
  return tcData.vendor?.consents?.[vendorId] === true;
}

/**
 * Follows the CMP's TCF signal for one vendor. False until the CMP says yes, and stays false when
 * no CMP shows up, because then nothing can say consent was given.
 */
export function useTcfVendorConsent(vendorId: number) {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let listenerId: number | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const startedAt = Date.now();

    const attach = () => {
      if (typeof window.__tcfapi !== 'function') return false;
      window.__tcfapi('addEventListener', 2, (tcData: TcData, success: boolean) => {
        if (tcData?.listenerId != null) listenerId = tcData.listenerId;
        const verdict = tcfAllowsVendor(tcData, success, vendorId);
        if (verdict !== null && !cancelled) setAllowed(verdict);
      });
      return true;
    };

    if (!attach()) {
      poll = setInterval(() => {
        if (attach() || Date.now() - startedAt > CMP_WAIT_MS) clearInterval(poll);
      }, CMP_POLL_MS);
    }

    return () => {
      cancelled = true;
      clearInterval(poll);
      if (listenerId != null && typeof window.__tcfapi === 'function')
        window.__tcfapi('removeEventListener', 2, () => undefined, listenerId);
    };
  }, [vendorId]);

  return allowed;
}

/** Sparteo's tag, loaded only once the CMP reports consent for Sparteo (or that GDPR does not apply). */
export function SparteoTag() {
  const allowed = useTcfVendorConsent(SPARTEO_TCF_VENDOR_ID);
  if (!allowed) return null;
  return <Script id="sparteo-tag" data-cfasync="false" src={SPARTEO_TAG_SRC} />;
}
