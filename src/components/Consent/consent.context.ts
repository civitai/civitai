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
//  2) Initial render on the server / before the lazy CA manager hydrates: the
//     CA manager wraps its children in another Provider with the real state.
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
