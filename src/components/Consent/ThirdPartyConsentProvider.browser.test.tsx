import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import type { RegionInfo } from '~/server/utils/region-blocking';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { ServerDomains } from '~/shared/constants/domain.constants';

/**
 * 🔴 THE FAIL-OPEN THIS SUITE EXISTS FOR.
 *
 * `ThirdPartyConsentProvider` used to take `region` as a PROP threaded from `_app`, and it
 * re-evaluates `isConsentRequired(region)` on every render. But `region` is SSR-ONLY:
 * `MyApp.getInitialProps` early-returns on a client-side navigation (`if (!request) return
 * initialProps;`) and `const region = getRegion(request)` lives below that guard — pinned
 * independently, against the real `getInitialProps`, by the `SERVERSIDE_ONLY_PROPS` ledger in
 * `src/server/__tests__/app-settings-bootstrap.test.ts`.
 *
 * So a California visitor who had explicitly REJECTED third-party analytics/advertising kept
 * the gate only until their first client-side navigation. At that point
 * `isConsentRequired(undefined)` returned false, `CAConsentManager` unmounted, and every
 * `useThirdPartyConsent()` consumer fell through to the context DEFAULT in
 * `src/components/Consent/consent.context.ts` — `{ required: false, allowed: true }` — silently
 * re-enabling the scripts for the rest of the session. Nothing threw and nothing was logged.
 *
 * The fix reads `region` from `useAppContext()`, whose value `AppProvider` freezes in a
 * `useState` initializer at mount and therefore survives a client-side navigation.
 *
 * ## Why this mounts the REAL `AppProvider`
 *
 * The defect lives in the SEAM between two components, not inside either one: `AppProvider`
 * freezing its context value, and `ThirdPartyConsentProvider` reading region from there. A
 * `vi.mock` of `useAppContext` — what every other component test in this repo does — would
 * assert the second half against a fake first half and go green even if `AppProvider` stopped
 * freezing. So the real provider is mounted, with only the four ambient tRPC queries it fires
 * stubbed (the network boundary), and `rerender` drives the navigation.
 *
 * ## Why the harness still passes a `region` PROP to the consent provider
 *
 * So that this file reproduces the ACTUAL regression rather than merely a missing prop. The
 * harness mirrors `_app` as it was BEFORE the fix — region threaded to both the frozen
 * `AppProvider` and the consent provider — and then drops the prop to model the client-side
 * navigation, exactly as `_app` did. Pre-fix that makes the first assertion pass and the
 * post-navigation one fail; post-fix the prop is simply ignored. Measured both ways; see the
 * PR. The cast is what lets one harness feed both component APIs: post-fix
 * `ThirdPartyConsentProvider` declares no `region` prop, and React ignores props a component
 * does not read.
 */

// 🔴 SIBLING FILE, SAME STUB. `ThirdPartyConsentProvider.ssrHydration.browser.test.tsx` stubs
// the SAME four ambient queries. `AppProvider` has accreted them one at a time, so a fifth must
// be added to BOTH. This is a comment rather than a shared module because the failure is LOUD:
// an unstubbed query is a `TypeError` naming the missing property during render, not a silent
// zero, and the duplicate is eight lines of fixture with no logic in it.
// Only the AMBIENT queries `AppProvider` fires on mount. Spread of the original module, not a
// wholesale replacement — `local-rules/no-wholesale-module-mock` bans the latter, and an
// omitted export fails the whole file at COLLECTION, reported as "no tests" rather than red.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  const seeded = () => ({ data: undefined, isInitialLoading: false });
  return {
    ...actual,
    trpc: {
      user: {
        getSettings: { useQuery: seeded },
        getFollowingUsers: { useQuery: seeded },
      },
      system: { getLiveNow: { useQuery: seeded } },
      chat: { getUserSettings: { useQuery: seeded } },
    },
  };
});

import { renderWithProviders } from '../../../test/component-setup';
import { AppProvider } from '~/providers/AppProvider';
import { ThirdPartyConsentProvider } from '~/components/Consent/ThirdPartyConsentProvider';
import { useThirdPartyConsent } from '~/components/Consent/consent.context';
import type { ConsentDecision } from '~/components/Consent/consent.utils';

/** `US:CA` is the only entry in `CONSENT_REQUIRED_REGIONS` today. */
const CALIFORNIA: RegionInfo = { countryCode: 'US', regionCode: 'CA', fullLocationCode: 'US:CA' };
/** A region the gate must NOT apply to — the reachability control for `data-allowed: 'true'`. */
const TEXAS: RegionInfo = { countryCode: 'US', regionCode: 'TX', fullLocationCode: 'US:TX' };

const SERVER_DOMAINS: ServerDomains = {
  green: { primary: 'civitai.green', aliases: [] },
  blue: { primary: 'civitai.com', aliases: [] },
  red: { primary: 'civitai.red', aliases: [] },
};

/**
 * 🔴 ONE CONTROL THE CONSENT ASSERTIONS CANNOT PROVIDE FOR THEMSELVES, AND ONE SEPARATE CLAIM.
 *
 * Post-fix the simulated navigation is a semantic NO-OP by construction — `region` is the only
 * prop that moves, `AppProvider` freezes it, and the consent provider no longer reads it — so
 * every post-navigation assertion is identical to its pre-navigation twin. Green therefore
 * cannot distinguish "the navigation happened and the gate survived" from "`rerender` did
 * nothing at all". The red-at-base run proves the mechanism TODAY, but it lives in a PR
 * description, not in this file: one harness change (a `wrapper` tweak, a vitest-browser-react
 * bump, a "simplification" of `AppShell`) and the file goes inert with a full green.
 *
 *   - `data-nav` is an arrival assertion that the re-render REACHED this subtree. It is
 *     gate-independent — children render on both branches of `isConsentRequired` — so it stays
 *     valid pre- and post-fix, and it fails fast and legibly if propagation stops.
 *   - `data-mounts` on `<MountLedger>` is NOT a control for those two — it is its own test, with
 *     its own claim. It reports how many times this subtree has MOUNTED. Pre-fix,
 *     flipping the gate predicate changed the child element's type at that position
 *     (`CAConsentManager` → Fragment), so React unmounted and remounted EVERYTHING below the
 *     consent provider — which in `_app` is the whole app. Post-fix it must stay at 1.
 *
 * Both flagged by the `civitai-test-review` lane, which named the exact inert-harness mutant.
 *
 * 🔴 THE LEDGER PUBLISHES THROUGH THE DOM ON PURPOSE. Reading the module counter directly would
 * be a synchronous negative ("it did not increment"), which can only ever read LOW — i.e. fail
 * toward "no remount" — because React flushes passive effects on a later task. A remounted
 * instance starts at 0 and publishes its own ordinal once its effect runs, so
 * `toHaveAttribute('data-mounts', '1')` is an ARRIVAL assertion: on a remount it polls against
 * `'2'` and goes red rather than racing.
 */
let subtreeMounts = 0;

function MountLedger() {
  const [ordinal, setOrdinal] = React.useState(0);
  React.useEffect(() => {
    subtreeMounts += 1;
    setOrdinal(subtreeMounts);
  }, []);
  return <i data-testid="mount-ledger" data-mounts={String(ordinal)} />;
}

/** Mirrors what a `useThirdPartyConsent()` consumer (GoogleAnalytics, AdsProvider, the embeds) reads. */
function Probe({ nav }: { nav: number }) {
  const { consent, required, allowed } = useThirdPartyConsent();
  return (
    <div
      data-testid="consent-probe"
      data-required={String(required)}
      data-allowed={String(allowed)}
      data-consent={consent ?? 'none'}
      data-nav={String(nav)}
    />
  );
}

// See the header: one harness, both component APIs. `React.ComponentProps` keeps the rest of
// the props honest, so a real signature change still fails here rather than being cast away.
const ConsentProviderWithLegacyRegionProp =
  ThirdPartyConsentProvider as unknown as React.ComponentType<
    React.ComponentProps<typeof ThirdPartyConsentProvider> & { region?: RegionInfo }
  >;

/**
 * The `_app` wiring, reduced to the two providers that matter. `region` is threaded to BOTH,
 * as `_app` did pre-fix; passing `undefined` is a client-side navigation.
 */
function AppShell({
  region,
  initialConsent,
  nav,
  remountKey,
}: {
  region: RegionInfo | undefined;
  initialConsent: ConsentDecision | null;
  /** Bumped on the simulated navigation; see the controls above. */
  nav: number;
  /**
   * Forces a remount at the CONSENT PROVIDER's own position when it changes — the exact
   * position the pre-fix remount happened at, which is why the instrument check keys here
   * rather than on `AppShell`.
   */
  remountKey?: string;
}) {
  return (
    <AppProvider
      seed={1}
      canIndex={false}
      settings={{} as UserContentSettings}
      liveNow={false}
      region={region}
      domain="blue"
      host="civitai.com"
      serverDomains={SERVER_DOMAINS}
      availableOAuthProviders={[]}
      verifiedBot={null}
      isAuthed={false}
    >
      <ConsentProviderWithLegacyRegionProp
        key={remountKey}
        region={region}
        initialConsent={initialConsent}
        loggedIn={false}
      >
        <MountLedger />
        <Probe nav={nav} />
      </ConsentProviderWithLegacyRegionProp>
    </AppProvider>
  );
}

const probe = () => page.getByTestId('consent-probe');
const mountLedger = () => page.getByTestId('mount-ledger');

beforeEach(() => {
  subtreeMounts = 0;
});

describe('ThirdPartyConsentProvider — the consent gate must survive a client-side navigation', () => {
  test('🔴 a CA visitor who REJECTED stays rejected after `_app` loses its region prop', async () => {
    const { rerender } = await renderWithProviders(
      <AppShell region={CALIFORNIA} initialConsent="rejected" nav={0} />
    );

    // First (server-rendered) page load: the gate is up and the rejection is honoured.
    await expect.element(probe()).toHaveAttribute('data-required', 'true');
    await expect.element(probe()).toHaveAttribute('data-allowed', 'false');
    await expect.element(probe()).toHaveAttribute('data-consent', 'rejected');

    // The client-side navigation. `_app` re-renders with `region` absent from pageProps;
    // AppProvider stays MOUNTED (same element type, same position) so its frozen context
    // value is unchanged, and this is the only thing standing between the visitor and
    // `allowed: true`.
    await rerender(<AppShell region={undefined} initialConsent="rejected" nav={1} />);

    // LIVENESS FIRST: the re-render reached this subtree. Without it a `rerender` that
    // silently did nothing would satisfy every consent assertion below.
    await expect.element(probe()).toHaveAttribute('data-nav', '1');

    await expect.element(probe()).toHaveAttribute(
      'data-allowed',
      'false'
      // If this reads 'true', CAConsentManager unmounted on the navigation and every
      // consumer fell through to the ALLOW default — analytics and ads are back on for a
      // visitor who rejected them. That is the compliance exposure, not a lost UI state.
    );
    await expect.element(probe()).toHaveAttribute('data-required', 'true');
    await expect.element(probe()).toHaveAttribute('data-consent', 'rejected');
  });

  test('🔴 a CA visitor who has NOT decided is still ASKED after a client-side navigation', async () => {
    const { rerender } = await renderWithProviders(
      <AppShell region={CALIFORNIA} initialConsent={null} nav={0} />
    );

    await expect.element(probe()).toHaveAttribute('data-required', 'true');
    await expect.element(probe()).toHaveAttribute('data-allowed', 'false');
    await expect.element(page.getByText('Your privacy choices', { exact: true })).toBeVisible();

    await rerender(<AppShell region={undefined} initialConsent={null} nav={1} />);

    await expect.element(probe()).toHaveAttribute('data-nav', '1');

    // Still pending, still blocked, still asking. Pre-fix the banner disappeared and
    // `allowed` flipped to true — the visitor was never asked and was tracked anyway.
    await expect.element(probe()).toHaveAttribute('data-required', 'true');
    await expect.element(probe()).toHaveAttribute('data-allowed', 'false');
    await expect.element(page.getByText('Your privacy choices', { exact: true })).toBeVisible();
  });

  /**
   * The remount half, in its own test so it is REACHABLE on the pre-fix tree. Folded into the
   * first test it sat behind the consent assertions, which abort there — so on the one mutation
   * it exists for it never executed. Found by the `civitai-test-review` lane.
   */
  test('🔴 nothing below the gate REMOUNTS across a client-side navigation', async () => {
    const { rerender } = await renderWithProviders(
      <AppShell region={CALIFORNIA} initialConsent="rejected" nav={0} />
    );

    await expect.element(mountLedger()).toHaveAttribute('data-mounts', '1');

    await rerender(<AppShell region={undefined} initialConsent="rejected" nav={1} />);
    await expect.element(probe()).toHaveAttribute('data-nav', '1');

    // Pre-fix the predicate flipped, which changed the child element's TYPE at this position,
    // so React tore down and rebuilt the whole subtree — in `_app`, the entire app, once per
    // session mid-navigation, for acceptors as well as rejecters. This reads '2' there.
    await expect.element(mountLedger()).toHaveAttribute('data-mounts', '1');
  });

  /**
   * 🔴 INSTRUMENT CHECK for the ledger. The test above asserts a 1, and so does every other arm
   * in this file — none of them can show that a 2 is reachable through this harness at all, so
   * without this the remount test could be green because the ledger is incapable of counting
   * past one. A `key` change on the CONSENT PROVIDER element — the exact position the pre-fix
   * remount happened at — forces a remount there; the ledger must see it.
   */
  test('🔴 INSTRUMENT CHECK: the mount ledger DOES report a remount when one happens', async () => {
    const { rerender } = await renderWithProviders(
      <AppShell region={CALIFORNIA} initialConsent="rejected" nav={0} remountKey="first" />
    );
    await expect.element(mountLedger()).toHaveAttribute('data-mounts', '1');

    await rerender(
      <AppShell region={CALIFORNIA} initialConsent="rejected" nav={1} remountKey="second" />
    );

    await expect.element(mountLedger()).toHaveAttribute('data-mounts', '2');
  });

  test('a non-consent region is NOT gated — the control for the two consent tests', async () => {
    const { rerender } = await renderWithProviders(
      <AppShell region={TEXAS} initialConsent={null} nav={0} />
    );

    // No Provider is rendered, so consumers read the context default. This is the arm that
    // proves `data-allowed: 'true'` is reachable through this harness at all — without it,
    // the assertions above could be green because the probe can only ever say 'false'.
    await expect.element(probe()).toHaveAttribute('data-required', 'false');
    await expect.element(probe()).toHaveAttribute('data-allowed', 'true');
    await expect.element(probe()).toHaveAttribute('data-consent', 'none');

    await rerender(<AppShell region={undefined} initialConsent={null} nav={1} />);

    await expect.element(probe()).toHaveAttribute('data-nav', '1');
    await expect.element(probe()).toHaveAttribute('data-required', 'false');
    await expect.element(probe()).toHaveAttribute('data-allowed', 'true');
  });
});
