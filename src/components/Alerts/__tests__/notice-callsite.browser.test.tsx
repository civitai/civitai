import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcUtils from '~/utils/trpc';
import type { ReferralDashboardData } from '~/components/Referrals/dashboard.types';

// =============================================================================
// CALL-SITE → PERSISTED-ID guard.
//
// `notice-registry.test.ts` pins what each registry ENTRY's id is. Nothing
// there pins that a given piece of UI reaches for the RIGHT entry. Before the
// consolidation the id literal sat beside its component, so a notice could not
// be mis-pointed; now that every site indexes one shared record, writing
//     const ALERT_HOW_IT_WORKS = FEATURE_NOTICES.referralTokenShop.id;
// makes two unrelated notices dismiss each other — per-user, invisible, and
// with the whole suite still green.
//
// This file closes that. For every dismiss/restore affordance, it MOUNTS the
// real component, CLICKS that specific control, and asserts the wire payload
// the component actually sends. The claim is a RELATIONSHIP — "this control
// dismisses this id" — not a restatement of the registry.
//
// 🔴 Every expected id below is a HAND-TYPED LITERAL, never derived from
// `FEATURE_NOTICES`. Deriving it (`FEATURE_NOTICES.referralKickback.id`) would
// make this file agree with any re-pointing or rename, which is the single
// thing it exists to catch. The strings are the same ones already persisted in
// real users' `User.settings.dismissedAlerts`; changing one is a data
// migration, not a refactor. Same rule, and same reason, as the
// `ID_AT_ITS_ORIGINAL_CALL_SITE` table in `notice-registry.test.ts`.
//
// COVERAGE — all 9 registry entries, 11 (affordance → id) pairs:
//   here  earnBlueBuzzRewards     BuyBuzzModal / EarnRewardsBanner
//   here  remixGalleryExplainer   RemixGallery / RemixGalleryExplainer
//   here  referralLiteOnboarding  Referrals / ReferralDashboard   (dismiss + restore)
//   here  referralKickback        Referrals / ReferralDashboard
//   here  referralHowItWorks      Referrals / ReferralDashboardFull
//   here  referralKickback        Referrals / ReferralDashboardFull
//   here  referralTokenShop       Referrals / ReferralDashboardFull
//   ↳ `feature-notice.characterization.browser.test.tsx` already asserts the
//     same wire payload for the remaining three — navTidy,
//     yellowBuzzMigration and cryptoOnrampGuidance (dismiss + restore). They
//     are deliberately NOT duplicated here; that file is the older
//     characterization record and re-asserting it would create two places to
//     update. `notice-callsite-coverage.test.ts` is what fails if a tenth call
//     site ever appears without landing in one of the two.
// =============================================================================

const mocks = vi.hoisted(() => {
  const state = {
    settings: { dismissedAlerts: [] } as Record<string, any> | undefined,
    currentUser: { id: 1 } as any,
    features: {} as Record<string, any>,
    /** Every `user.dismissAlert` payload, in call order. The assertion target. */
    mutateCalls: [] as Array<{ alertId: string; dismiss?: boolean }>,
  };

  // Same reactive-store shim as the characterization file: `setData` has to
  // actually re-render, or an optimistic dismissal is observable only inside
  // the fake cache and never on screen.
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => void listeners.delete(cb);
  };
  const snapshot = () => state.settings;

  const utils = {
    user: {
      getSettings: {
        cancel: async () => undefined,
        getData: () => state.settings,
        setData: (_key: undefined, updater: any) => {
          state.settings = typeof updater === 'function' ? updater(state.settings) : updater;
          emit();
        },
        invalidate: () => undefined,
      },
    },
  };

  // Runs the component's REAL onMutate/onSettled against the fake cache, so the
  // click path exercised here is the same one production takes.
  const useDismissMutation = (opts: any) => ({
    mutate: (vars: { alertId: string; dismiss?: boolean }) => {
      state.mutateCalls.push(vars);
      void Promise.resolve(opts?.onMutate?.(vars)).then((ctx) =>
        opts?.onSettled?.(undefined, null, vars, ctx)
      );
    },
    isPending: false,
    isLoading: false,
  });

  return { state, subscribe, snapshot, utils, useDismissMutation };
});

// Browser mode serves native ESM, so `vi.hoisted` runs before React is
// importable. The one mock needing a hook lives out here as a hoisted function
// declaration and is called through an arrow, so it resolves at render time.
function useSettingsQuery(_input?: unknown, opts?: { enabled?: boolean }) {
  const data = React.useSyncExternalStore(mocks.subscribe, mocks.snapshot, mocks.snapshot);
  const enabled = opts?.enabled ?? true;
  return { data: enabled ? data : undefined, isLoading: false, isError: false };
}

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcUtils>()),
  trpc: {
    user: {
      getSettings: {
        useQuery: (input?: unknown, opts?: { enabled?: boolean }) => useSettingsQuery(input, opts),
      },
      dismissAlert: { useMutation: mocks.useDismissMutation },
    },
    referral: { getTierBonuses: { useQuery: () => ({ data: undefined }) } },
    subscriptions: { getPlans: { useQuery: () => ({ data: [] }) } },
    useUtils: () => mocks.utils,
  },
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.state.currentUser,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => mocks.state.features,
  useFeatureFlagsReady: () => true,
}));

// `useAppContext` is listed as well as `useServerDomains`: something in this
// import graph pulls it, and a factory that omits an export a consumer imports
// fails the whole file at COLLECTION — reported as "no tests", not as a red
// test. (`importOriginal` is not the fix here; the real provider does not load
// in browser mode.)
vi.mock('~/providers/AppProvider', () => ({
  useAppContext: () => ({
    serverDomains: {
      green: { primary: 'civitai.green' },
      blue: { primary: 'civitai.com' },
      red: { primary: 'civitai.red' },
    },
    canIndex: true,
    seed: Date.now(),
    availableOAuthProviders: [],
    verifiedBot: null,
  }),
  useServerDomains: () => ({ green: 'civitai.com', red: 'civitai.red', blue: 'civitai.blue' }),
}));

vi.mock('~/utils/sync-account', () => ({ syncAccount: (url: string) => url }));

vi.mock('~/components/Payments/usePaymentProvider', () => ({
  usePaymentProvider: () => 'Paddle',
}));

import { renderWithProviders } from '../../../../test/component-setup';
import { EarnRewardsBanner } from '~/components/Modals/BuyBuzzModal';
import { RemixGalleryExplainer } from '~/components/RemixGallery/RemixGalleryExplainer';
import { ReferralDashboard } from '~/components/Referrals/ReferralDashboard';
import { ReferralDashboardFull } from '~/components/Referrals/ReferralDashboardFull';

beforeEach(() => {
  mocks.state.settings = { dismissedAlerts: [] };
  mocks.state.currentUser = { id: 1 };
  mocks.state.features = {};
  mocks.state.mutateCalls = [];
});

// -----------------------------------------------------------------------------
// Locating ONE affordance among several that share an accessible name.
//
// `ReferralDashboardFull` renders THREE controls whose accessible name is
// "Dismiss" — one Button and two CloseButtons. `getByRole('button', { name:
// 'Dismiss' })` cannot separate them, and picking by index would silently
// re-point itself the moment the cards are reordered, which is exactly the
// class of bug this file exists to catch.
//
// So each control is found through the notice's OWN copy: take the deepest
// element carrying a text fragment unique to that notice, then walk up until an
// ancestor holds exactly ONE dismiss control. Two loud failures instead of a
// silent wrong click — "no dismiss control" if the markup moves apart, and
// "ambiguous" if a climb reaches a container holding several.
// -----------------------------------------------------------------------------

/** The deepest element whose text contains `snippet`. */
function deepestContaining(snippet: string): HTMLElement {
  const matches = (Array.from(document.querySelectorAll('*')) as HTMLElement[]).filter((el) =>
    el.textContent?.includes(snippet)
  );
  if (matches.length === 0) {
    throw new Error(`notice copy not on screen: no element contains ${JSON.stringify(snippet)}`);
  }
  const deepest = matches.find(
    (el) => !matches.some((other) => other !== el && el.contains(other))
  );
  if (!deepest) throw new Error(`could not resolve a deepest node for ${JSON.stringify(snippet)}`);
  return deepest;
}

const isDismissControl = (el: HTMLElement) =>
  el.getAttribute('aria-label') === 'Dismiss' || el.textContent?.trim() === 'Dismiss';

/**
 * The single dismiss control belonging to the notice whose copy contains
 * `snippet`.
 */
function dismissControlFor(snippet: string): HTMLElement {
  let node: HTMLElement | null = deepestContaining(snippet);
  while (node) {
    const found = (Array.from(node.querySelectorAll('button')) as HTMLElement[]).filter(
      isDismissControl
    );
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new Error(
        `ambiguous: ${found.length} dismiss controls share the nearest ancestor of ` +
          `${JSON.stringify(snippet)} — this helper can no longer attribute a click`
      );
    }
    node = node.parentElement;
  }
  throw new Error(`no dismiss control found for ${JSON.stringify(snippet)}`);
}

/**
 * One payload rendered as a flat string: `dismiss <id>` / `restore <id>`.
 *
 * Asserted BEFORE the raw array because a string-array diff prints both ids in
 * full. `toEqual` on the objects truncates to `[ Array(1) ]` at this depth,
 * which names the expected id (from the message) but hides the one the call
 * site actually sent — and "which notice did it dismiss instead" is the whole
 * question when this test goes red.
 */
const persistedSummary = () =>
  mocks.state.mutateCalls.map((c) =>
    c.dismiss === false ? `restore ${c.alertId}` : `dismiss ${c.alertId}`
  );

/** Assert the exact payloads sent so far, with the site named in the message. */
function expectPersisted(site: string, expected: Array<{ alertId: string; dismiss?: boolean }>) {
  const expectedSummary = expected.map((c) =>
    c.dismiss === false ? `restore ${c.alertId}` : `dismiss ${c.alertId}`
  );
  return vi.waitFor(() => {
    // Readable first: names both sides of the mismatch.
    expect(
      persistedSummary(),
      `${site} must persist exactly ${JSON.stringify(expectedSummary)} — a mismatch here means ` +
        `this call site is pointed at the wrong FEATURE_NOTICES entry, so it dismisses another ` +
        `notice instead of its own`
    ).toEqual(expectedSummary);
    // Exact second: the summary above collapses `dismiss: true` and an omitted
    // flag, which are equivalent on the wire but not identical payloads.
    expect(mocks.state.mutateCalls, `${site} raw dismissAlert payloads`).toEqual(expected);
  });
}

// -----------------------------------------------------------------------------
// BuyBuzzModal — the blue-buzz rewards banner.
// -----------------------------------------------------------------------------
describe('BuyBuzzModal / EarnRewardsBanner', () => {
  test('its Dismiss persists `earn-blue-buzz-rewards`', async () => {
    renderWithProviders(<EarnRewardsBanner />);

    await expect
      .element(page.getByText('You can earn Blue Buzz for free, every day.', { exact: false }))
      .toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Dismiss' }));

    await expectPersisted('BuyBuzzModal / EarnRewardsBanner', [
      { alertId: 'earn-blue-buzz-rewards' },
    ]);
  });

  test('is gone once `earn-blue-buzz-rewards` is already dismissed', async () => {
    // Negative control: proves the component reads THIS id from stored state,
    // not merely that its button sends it. A site pointed elsewhere would still
    // be on screen here.
    mocks.state.settings = { dismissedAlerts: ['earn-blue-buzz-rewards'] };
    renderWithProviders(
      <>
        <EarnRewardsBanner />
        <span data-testid="buy-buzz-sentinel">mounted</span>
      </>
    );

    await expect.element(page.getByTestId('buy-buzz-sentinel')).toBeVisible();
    expect(document.querySelectorAll('[aria-label="Dismiss"]')).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// RemixGalleryExplainer — inline gallery card.
// -----------------------------------------------------------------------------
describe('RemixGallery / RemixGalleryExplainer', () => {
  test('its Dismiss persists `remix-gallery-explainer`', async () => {
    renderWithProviders(<RemixGalleryExplainer />);

    await expect.element(page.getByRole('button', { name: 'Dismiss' })).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Dismiss' }));

    await expectPersisted('RemixGallery / RemixGalleryExplainer', [
      { alertId: 'remix-gallery-explainer' },
    ]);
  });

  test('is gone once `remix-gallery-explainer` is already dismissed', async () => {
    mocks.state.settings = { dismissedAlerts: ['remix-gallery-explainer'] };
    renderWithProviders(
      <>
        <RemixGalleryExplainer />
        <span data-testid="remix-sentinel">mounted</span>
      </>
    );

    await expect.element(page.getByTestId('remix-sentinel')).toBeVisible();
    expect(document.querySelectorAll('[aria-label="Dismiss"]')).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// The two referral dashboards.
//
// `settledTokens > 0` is what mounts the lite dashboard's tickets card, which
// is where its kickback alert lives. Everything else is the smallest shape that
// renders; the fixture's values are irrelevant to these assertions, which read
// only the `alertId` a click produces.
// -----------------------------------------------------------------------------
const referralData = {
  code: 'TESTCODE',
  balance: {
    settledBlueBuzzLifetime: 0,
    lifetimePoints: 0,
    pendingPoints: 0,
    lifetimeTokens: 3,
    settledTokens: 3,
    pendingTokens: 0,
    expiringSoonTokens: 0,
    nextTokenExpiresAt: null,
  },
  recentRewards: [],
  milestones: [],
  redemptions: [],
  shopItems: [
    { cost: 1, tier: 'bronze', durationDays: 14 },
    { cost: 3, tier: 'silver', durationDays: 14 },
  ],
  milestoneLadder: [{ threshold: 1_000, bonus: 500 }],
  conversionCount: 0,
  referralGrant: null,
  activeMembership: null,
} as unknown as ReferralDashboardData;

const referralProps = {
  data: referralData,
  shareLink: 'https://civitai.com/?ref=TESTCODE',
  onRedeem: () => undefined,
  isRedeeming: false,
  pendingOffer: null,
};

describe('Referrals / ReferralDashboard (lite)', () => {
  const KICKBACK_COPY = 'Tickets come from friends paying for a Membership with your code';

  test('the onboarding stepper’s "Got it" persists `referral-lite-onboarding`', async () => {
    renderWithProviders(<ReferralDashboard {...referralProps} />);

    await expect.element(page.getByRole('button', { name: 'Got it' })).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Got it' }));

    await expectPersisted('ReferralDashboard (lite) onboarding stepper', [
      { alertId: 'referral-lite-onboarding' },
    ]);
  });

  test('the kickback alert’s Dismiss persists `referral-kickback-info`', async () => {
    renderWithProviders(<ReferralDashboard {...referralProps} />);

    await expect.element(page.getByText(KICKBACK_COPY, { exact: false })).toBeVisible();
    await userEvent.click(dismissControlFor(KICKBACK_COPY));

    await expectPersisted('ReferralDashboard (lite) kickback alert', [
      { alertId: 'referral-kickback-info' },
    ]);
  });

  test('"How does it work?" RESTORES `referral-lite-onboarding` with dismiss:false', async () => {
    // The restore path sends a different payload shape, so it is a separate
    // wiring that can be mis-pointed independently of the dismiss above.
    mocks.state.settings = { dismissedAlerts: ['referral-lite-onboarding'] };
    renderWithProviders(<ReferralDashboard {...referralProps} />);

    await expect.element(page.getByRole('button', { name: 'How does it work?' })).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'How does it work?' }));

    await expectPersisted('ReferralDashboard (lite) onboarding restore', [
      { alertId: 'referral-lite-onboarding', dismiss: false },
    ]);
  });

  test('each notice reads its OWN stored id — dismissing one leaves the other on screen', async () => {
    // Negative control for both lite sites at once. If either were pointed at
    // the other's entry, seeding one id would hide both (or neither).
    mocks.state.settings = { dismissedAlerts: ['referral-lite-onboarding'] };
    renderWithProviders(<ReferralDashboard {...referralProps} />);

    await expect.element(page.getByText(KICKBACK_COPY, { exact: false })).toBeVisible();
    expect(page.getByRole('button', { name: 'Got it' }).elements()).toHaveLength(0);
  });
});

describe('Referrals / ReferralDashboardFull', () => {
  const HOW_IT_WORKS_COPY = 'How it works';
  const KICKBACK_COPY = 'When a friend joins via your code and pays for a Membership';
  const TOKEN_SHOP_COPY = 'Tokens come from friends paying for a Membership with your code';

  test('the "How it works" card’s Dismiss persists `referral-how-it-works`', async () => {
    renderWithProviders(<ReferralDashboardFull {...referralProps} />);

    await expect.element(page.getByText(KICKBACK_COPY, { exact: false })).toBeVisible();
    await userEvent.click(dismissControlFor(HOW_IT_WORKS_COPY));

    await expectPersisted('ReferralDashboardFull "How it works" card', [
      { alertId: 'referral-how-it-works' },
    ]);
  });

  test('the kickback alert’s Dismiss persists `referral-kickback-info`', async () => {
    renderWithProviders(<ReferralDashboardFull {...referralProps} />);

    await expect.element(page.getByText(KICKBACK_COPY, { exact: false })).toBeVisible();
    await userEvent.click(dismissControlFor(KICKBACK_COPY));

    await expectPersisted('ReferralDashboardFull kickback alert', [
      { alertId: 'referral-kickback-info' },
    ]);
  });

  test('the token-shop alert’s Dismiss persists `referral-token-shop-info`', async () => {
    renderWithProviders(<ReferralDashboardFull {...referralProps} />);

    await expect.element(page.getByText(TOKEN_SHOP_COPY, { exact: false })).toBeVisible();
    await userEvent.click(dismissControlFor(TOKEN_SHOP_COPY));

    await expectPersisted('ReferralDashboardFull token-shop alert', [
      { alertId: 'referral-token-shop-info' },
    ]);
  });

  test('the three notices read three DIFFERENT stored ids', async () => {
    // The strongest negative control in this file, and the one that makes the
    // shared-id case honest: `referral-kickback-info` is deliberately ONE id
    // across both dashboards, so seeding it must hide the kickback alert while
    // leaving "How it works" and the token-shop alert untouched.
    mocks.state.settings = { dismissedAlerts: ['referral-kickback-info'] };
    renderWithProviders(<ReferralDashboardFull {...referralProps} />);

    await expect.element(page.getByText(TOKEN_SHOP_COPY, { exact: false })).toBeVisible();
    expect(page.getByText(KICKBACK_COPY, { exact: false }).elements()).toHaveLength(0);
    await expect.element(page.getByText(HOW_IT_WORKS_COPY, { exact: false })).toBeVisible();
  });
});
