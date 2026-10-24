import { useCallback, useMemo, useState } from 'react';
import { ConsentBanner } from './ConsentBanner';
import { ThirdPartyConsentContext } from './consent.context';
import {
  initialConsentDecision,
  requiredConsentContext,
  writeConsentCookie,
  type ConsentDecision,
} from './consent.utils';

type Props = {
  children: React.ReactNode;
  initialConsent: ConsentDecision | null;
  loggedIn: boolean;
};

export function CAConsentManager({ children, initialConsent, loggedIn }: Props) {
  const [consent, setConsent] = useState<ConsentDecision | null>(() =>
    initialConsentDecision(initialConsent, loggedIn)
  );

  const persist = useCallback((value: ConsentDecision) => {
    writeConsentCookie(value);
    setConsent(value);
  }, []);

  const reset = useCallback(() => {
    writeConsentCookie(null);
    setConsent(null);
  }, []);

  const value = useMemo(
    () => requiredConsentContext(consent, persist, reset),
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
