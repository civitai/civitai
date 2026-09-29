import { createContext, useContext } from 'react';
import type { ConsentDecision } from './consent.utils';

export type ThirdPartyConsentContext = {
  consent: ConsentDecision | null;
  required: boolean;
  allowed: boolean;
  accept: () => void;
  reject: () => void;
  reset: () => void;
};

// Default value applies in two situations:
//  1) Non-CA users: ThirdPartyConsentProvider intentionally renders no Provider,
//     so consumers fall through to this default — scripts allowed, no banner.
//  2) A consumer mounted outside ThirdPartyConsentProvider entirely — component
//     tests, which mount no provider: same fall-through. (NOT standalone pages:
//     those render via `getLayout` INSIDE _app's provider tree.)
// 🔴 This default is ALLOW, so anything that unmounts CAConsentManager silently
// re-enables third-party analytics/ads for a CA visitor who rejected them — it
// does not merely lose state. That is why ThirdPartyConsentProvider's
// `isConsentRequired` input must come from a source that survives client-side
// navigation (`useAppContext().region`, not `_app`'s SSR-only prop). Do not
// "simplify" that back into a prop; see that file's header.
const defaultValue: ThirdPartyConsentContext = {
  consent: null,
  required: false,
  allowed: true,
  accept: () => undefined,
  reject: () => undefined,
  reset: () => undefined,
};

export const ThirdPartyConsentContext = createContext<ThirdPartyConsentContext>(defaultValue);

export function useThirdPartyConsent(): ThirdPartyConsentContext {
  return useContext(ThirdPartyConsentContext);
}
