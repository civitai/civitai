import { useAppContext } from '~/providers/AppProvider';
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
  initialConsent: ConsentDecision | null;
  loggedIn: boolean;
};

/**
 * 🔴 `region` COMES FROM `useAppContext()`, NEVER FROM A PROP THREADED BY `_app`.
 *
 * `isConsentRequired` fails OPEN — an absent region means "no consent gate". That is the
 * right default for a genuinely unknown region, and a compliance hole the moment the
 * region merely goes MISSING on a path where it is in fact known.
 *
 * `_app`'s `region` is SSR-ONLY: `MyApp.getInitialProps` early-returns on a client-side
 * navigation (`if (!request) return initialProps;`) and `const region = getRegion(request)`
 * lives below that guard, so `region` is `undefined` in `pageProps` on EVERY route
 * transition. This component re-evaluates on every render. Reading the prop therefore
 * meant: a CA visitor who had explicitly REJECTED consent kept the gate only until their
 * first client-side navigation, at which point `isConsentRequired(undefined)` returned
 * false, `CAConsentManager` unmounted, and every `useThirdPartyConsent()` consumer fell
 * through to the context DEFAULT — `allowed: true` — re-enabling third-party analytics and
 * advertising for the rest of the session. Same root cause as the `<FaroProvider>`
 * white-screen (#5001/#5027); that one crashed loudly, this one failed silently.
 *
 * `AppProvider` freezes its context value in a `useState` initializer, seeded from the SAME
 * SSR `region`, and it sits ABOVE this component in `_app`. So the context value survives
 * client-side navigation where the prop does not. It is also the source the other region
 * consumers (`CivitaiSessionProvider`, `useRegionWarning`) already read.
 *
 * `useAppContext()` THROWS without an `AppProvider` — deliberately, over
 * `useMaybeAppContext()`, which would hand back `undefined` and silently restore the exact
 * fail-open this fix closes. A broken provider nesting must be a loud developer error, not
 * a quiet compliance regression.
 *
 * Pinned by three files, each covering something the others cannot:
 *   - `src/components/Consent/ThirdPartyConsentProvider.browser.test.tsx` — the REGRESSION
 *     test. Mounts the real `AppProvider` and drives a client-side navigation; red before
 *     this fix, green after, and red again if `AppProvider` ever loses its freeze.
 *   - `src/components/Consent/ThirdPartyConsentProvider.ssrHydration.browser.test.tsx` — an
 *     INVARIANT guard (green on both sides): real `renderToString` → `hydrateRoot`, proving
 *     the context read costs nothing at hydration on the component that once produced the
 *     "double layout" mismatch described above.
 *   - `src/tests/pages/consent-gate-region-source.test.ts` — the structural ledger: no
 *     `region` prop here, none passed by `_app`, and `useMaybeAppContext` not used.
 */
export function ThirdPartyConsentProvider({ children, initialConsent, loggedIn }: Props) {
  const { region } = useAppContext();
  if (!isConsentRequired(region)) return <>{children}</>;
  return (
    <CAConsentManager initialConsent={initialConsent} loggedIn={loggedIn}>
      {children}
    </CAConsentManager>
  );
}
