import { useCallback, useMemo, useState } from 'react';
import type { RegionInfo } from '~/server/utils/region-blocking';
import { ConsentBanner } from './ConsentBanner';
import { CONSENT_NOT_REQUIRED, ThirdPartyConsentContext } from './consent.context';
import {
  initialConsentDecision,
  isConsentRequired,
  requiredConsentContext,
  writeConsentCookie,
  type ConsentDecision,
} from './consent.utils';

const REGION_PENDING: ThirdPartyConsentContext = {
  consent: null,
  required: false,
  allowed: false,
  accept: () => undefined,
  reject: () => undefined,
  reset: () => undefined,
};

type ShellConsentGateProps = {
  children: React.ReactNode;
  pending: boolean;
  region?: RegionInfo;
  initialConsent: ConsentDecision | null;
  loggedIn: boolean;
};

/**
 * The consent gate of an app that booted on a static shell page, where the region arrives after
 * mount. Closed (`allowed: false`) until it does, then the same verdict `CAConsentManager` or no
 * gate at all would give. One element for the whole session: switching between those two, as
 * `ThirdPartyConsentProvider` does by region, would remount the app below it when the region
 * arrives.
 */
export function ShellConsentGate({
  children,
  pending,
  region,
  initialConsent,
  loggedIn,
}: ShellConsentGateProps) {
  const required = !pending && isConsentRequired(region);
  // Frozen when the region arrives, as `CAConsentManager` freezes it at mount; by then the cookie
  // and the session have both been applied.
  const [initial, setInitial] = useState<ConsentDecision | null | undefined>(undefined);
  if (!pending && initial === undefined)
    setInitial(initialConsentDecision(initialConsent, loggedIn));
  const [choice, setChoice] = useState<{ consent: ConsentDecision | null } | null>(null);
  const consent = choice ? choice.consent : initial ?? null;

  const persist = useCallback((value: ConsentDecision) => {
    writeConsentCookie(value);
    setChoice({ consent: value });
  }, []);
  const reset = useCallback(() => {
    writeConsentCookie(null);
    setChoice({ consent: null });
  }, []);

  const value = useMemo<ThirdPartyConsentContext>(() => {
    if (pending) return REGION_PENDING;
    if (!required) return CONSENT_NOT_REQUIRED;
    return requiredConsentContext(consent, persist, reset);
  }, [pending, required, consent, persist, reset]);

  return (
    <ThirdPartyConsentContext.Provider value={value}>
      {children}
      {required && consent === null && <ConsentBanner />}
    </ThirdPartyConsentContext.Provider>
  );
}
