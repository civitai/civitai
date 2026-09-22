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
// be added to BOTH — and the reason this is a comment rather than a shared module is that the
// failure is LOUD: an unstubbed query is a `TypeError` naming the missing property during
// render, not a silent zero. A shared factory would have to be pulled in inside the hoisted
// `vi.mock` callback, which trades a loud failure for a hoisting trap.
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
/** A region the gate must NOT apply to — the control for the ledger below. */
const TEXAS: RegionInfo = { countryCode: 'US', regionCode: 'TX', fullLocationCode: 'US:TX' };

const SERVER_DOMAINS: ServerDomains = {
  green: { primary: 'civitai.green', aliases: [] },
  blue: { primary: 'civitai.com', aliases: [] },
  red: { primary: 'civitai.red', aliases: [] },
};

/**
 * 🔴 TWO CONTROLS THE CONSENT ASSERTIONS CANNOT PROVIDE FOR THEMSELVES.
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
 *   - `data-mounts` counts how many times this subtree MOUNTED. Pre-fix, flipping the gate
 *     predicate changed the child element's type at that position (`CAConsentManager` →
 *     Fragment), so React unmounted and remounted EVERYTHING below the consent provider — which
 *     in `_app` is the whole app. Post-fix it must stay at 1. That makes the remount a measured
 *     quantity rather than a claim.
 *
 * Both flagged by the `civitai-test-review` lane, which named the exact inert-harness mutant.
 */
let subtreeMounts = 0;

function MountLedger() {
  React.useEffect(() => {
    subtreeMounts += 1;
  }, []);
  return null;
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
}: {
  region: RegionInfo | undefined;
  initialConsent: ConsentDecision | null;
  /** Bumped on the simulated navigation; see the two controls above. */
  nav: number;
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
    await vi.waitFor(() => expect(subtreeMounts).toBe(1));

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

    // 🔴 And the gate did not merely survive — nothing below it remounted. Pre-fix the
    // predicate flipped, which changed the child element's TYPE at this position, so React
    // tore down and rebuilt the whole subtree (in `_app`, the entire app). This is 2 on the
    // pre-fix tree and 1 here.
    expect(
      subtreeMounts,
      'the subtree under the consent provider remounted on a client-side navigation — pre-fix ' +
        'behaviour, caused by the gate predicate flipping and changing the child element type'
    ).toBe(1);
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

  test('a non-consent region is NOT gated — the control for the two tests above', async () => {
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
    // Never gated, so the predicate never flipped and nothing remounted — on the pre-fix tree
    // too. This arm is what says `subtreeMounts === 1` above is about the GATE and not about
    // `rerender` being incapable of remounting anything.
    expect(subtreeMounts).toBe(1);
  });
});
