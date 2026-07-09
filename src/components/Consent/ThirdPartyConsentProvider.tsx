import type { RegionInfo } from '~/server/utils/region-blocking';
import { isConsentRequired, type ConsentDecision } from './consent.utils';
import { CAConsentManager } from './CAConsentManager';

// CAConsentManager must be a STATIC import, not next/dynamic. It wraps the whole
// app (children), and under Turbopack dev a dynamically-imported wrapper loads
// its chunk async — so at hydration the children are absent, causing a
// whole-tree hydration mismatch that re-mounts the app and orphans the
// server-rendered DOM (the "double layout" bug). A static import keeps ssr:true
// correctness (script-gating context is right on first server render) while
// guaranteeing the component code is available synchronously at hydration.
// Only CA visitors actually render it (see below); the bundle cost for others
// is negligible now that ConsentBanner is the only heavy child and is gated.

type Props = {
  children: React.ReactNode;
  region: RegionInfo | null | undefined;
  initialConsent: ConsentDecision | null;
  loggedIn: boolean;
};

export function ThirdPartyConsentProvider({ children, region, initialConsent, loggedIn }: Props) {
  if (!isConsentRequired(region)) return <>{children}</>;
  return (
    <CAConsentManager initialConsent={initialConsent} loggedIn={loggedIn}>
      {children}
    </CAConsentManager>
  );
}
