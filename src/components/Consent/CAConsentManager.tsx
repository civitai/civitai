import { useCallback, useMemo, useState } from 'react';
import { ConsentBanner } from './ConsentBanner';
import { ThirdPartyConsentContext } from './consent.context';
import { CONSENT_COOKIE, CONSENT_COOKIE_MAX_AGE, type ConsentDecision } from './consent.utils';

type Props = {
  children: React.ReactNode;
  initialConsent: ConsentDecision | null;
  loggedIn: boolean;
};

export function CAConsentManager({ children, initialConsent, loggedIn }: Props) {
  // Cookie takes precedence over logged-in implicit consent: a user who
  // explicitly rejected before signing in stays rejected. Logged-in users
  // without an explicit cookie decision are treated as having accepted via
  // the Terms of Service (§ 8.7 discloses third-party analytics/advertising).
  const effectiveInitial: ConsentDecision | null = initialConsent ?? (loggedIn ? 'accepted' : null);
  const [consent, setConsent] = useState<ConsentDecision | null>(effectiveInitial);

  const persist = useCallback((value: ConsentDecision) => {
    if (typeof document !== 'undefined') {
      const secure = window.location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${CONSENT_COOKIE}=${value}; Path=/; Max-Age=${CONSENT_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
    }
    setConsent(value);
  }, []);

  const reset = useCallback(() => {
    if (typeof document !== 'undefined') {
      const secure = window.location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${CONSENT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
    }
    setConsent(null);
  }, []);

  const value = useMemo(
    () => ({
      consent,
      required: true,
      allowed: consent === 'accepted',
      accept: () => persist('accepted'),
      reject: () => persist('rejected'),
      reset,
    }),
    [consent, persist, reset]
  );

  return (
    <ThirdPartyConsentContext.Provider value={value}>
      {children}
      {consent === null && <ConsentBanner />}
    </ThirdPartyConsentContext.Provider>
  );
}

export default CAConsentManager;
