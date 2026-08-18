import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcUtils from '~/utils/trpc';

// =============================================================================
// CHARACTERIZATION of the hand-rolled `dismissedAlerts` notice pattern.
//
// Written against UNMODIFIED code and kept byte-identical across the
// consolidation onto `useFeatureNotice`, so a behaviour change during the
// refactor shows up here rather than in production. It therefore asserts what
// the four copies DO today, not what they arguably should do — the known
// disagreements between them are recorded in the PR body, not fixed here.
//
// 🔴 Every `alertId` string below is a LITERAL on purpose. These strings are
// already persisted in real users' `User.settings.dismissedAlerts`; importing
// them from the registry would let a rename pass this file while silently
// un-dismissing the notice for everyone who dismissed it. If one of these
// literals has to change, that is a data migration, not a refactor.
//
// Mount contexts covered, deliberately structurally different (a notice's bugs
// live in how it is mounted):
//   * NavTidyNotice            — a deferred-open Popover under the sub-nav
//   * YellowBuzzMigrationNotice — a Popover that WRAPS children in the header
//   * OnrampGuidance + Toggle  — an inline page card, and the only restore path
// =============================================================================

const mocks = vi.hoisted(() => {
  const state = {
    // `undefined` models the rare failed-SSR-snapshot path the components guard
    // against; `{}` models a settings object with no dismissedAlerts key.
    settings: undefined as Record<string, any> | undefined,
    isLoading: false,
    currentUser: { id: 1 } as any,
    flagsReady: true,
    features: {} as Record<string, any>,
    yellow: 0,
    invalidateCount: 0,
    mutateCalls: [] as Array<{ alertId: string; dismiss?: boolean }>,
  };

  // A tiny reactive store so `setData` actually re-renders the component, the
  // way react-query would. Without this the optimistic write is observable only
  // in the fake cache and never on screen, so "hides after dismiss" could not be
  // asserted at all.
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
        invalidate: () => {
          state.invalidateCount += 1;
        },
      },
    },
  };

  // Runs the REAL onMutate/onError/onSettled the component supplied, against the
  // fake cache above — so the optimistic-update shape and the reconcile-refetch
  // are both genuinely exercised rather than stubbed away.
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

// Browser mode serves native ESM, so `vi.hoisted` (which runs BEFORE any import
// is evaluated) cannot reach React. The one mock that needs a hook therefore
// lives out here as a hoisted function declaration, and the mock factory calls
// it through an arrow so the reference resolves at render time, not at factory
// time.
function useSettingsQuery(_input?: unknown, opts?: { enabled?: boolean }) {
  const data = React.useSyncExternalStore(mocks.subscribe, mocks.snapshot, mocks.snapshot);
  const enabled = opts?.enabled ?? true;
  return {
    data: enabled ? data : undefined,
    isLoading: enabled ? mocks.state.isLoading : false,
    isError: false,
  };
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
    buzz: {
      getBuzzAccount: {
        useQuery: (_i?: unknown, o?: { enabled?: boolean }) => ({
          data: o?.enabled === false ? undefined : { yellow: mocks.state.yellow },
        }),
      },
    },
    useUtils: () => mocks.utils,
  },
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.state.currentUser,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => mocks.state.features,
  // Required by `useFeatureNotice` for `audience`. None of the notices
  // characterized here declares one, so this changes nothing about what they
  // render — but omitting an export a consumer imports fails the file at
  // COLLECTION, which reads as "no tests" rather than as a failure.
  useOptionalFeatureFlags: () => mocks.state.features,
  useFeatureFlagsReady: () => mocks.state.flagsReady,
}));

vi.mock('~/providers/AppProvider', () => ({
  useServerDomains: () => ({ green: 'civitai.com', red: 'civitai.red', blue: 'civitai.blue' }),
}));

vi.mock('~/utils/sync-account', () => ({ syncAccount: (url: string) => url }));

import { renderWithProviders } from '../../../../test/component-setup';
import { NavTidyNotice } from '~/components/Alerts/NavTidyNotice';
import { YellowBuzzMigrationNotice } from '~/components/Alerts/YellowBuzzMigrationNotice';
import {
  OnrampGuidance,
  OnrampGuidanceToggle,
} from '~/components/Buzz/CryptoDeposit/OnrampGuidance';

beforeEach(() => {
  mocks.state.settings = { dismissedAlerts: [] };
  mocks.state.isLoading = false;
  mocks.state.currentUser = { id: 1 };
  mocks.state.flagsReady = true;
  mocks.state.features = {};
  mocks.state.yellow = 0;
  mocks.state.invalidateCount = 0;
  mocks.state.mutateCalls = [];
});

// -----------------------------------------------------------------------------
// NavTidyNotice — sub-nav Popover, opens on a post-mount defer.
//
// 🔴 This block does NOT use `vi.waitFor(() => expect(...).toHaveLength(0))`.
// A negative assertion is satisfied at t=0, and this tree mounts asynchronously
// (a concurrent root + a `useSyncExternalStore` read), so the first poll fires
// before React has committed anything — measured: the trigger is absent from
// the DOM at t=0 and present at t=2200 even on the fully-rendering path. Every
// such wait therefore passes instantly whether or not the notice renders, which
// is how three of these tests survived a mutation that made the component
// render when it must not.
//
// So each negative case: mount a SENTINEL alongside, wait for the sentinel
// (proves the tree committed), wait past the 1500 ms open defer, and only then
// assert absence — against `document`, because the trigger is not in the
// accessibility tree until the popover opens.
// -----------------------------------------------------------------------------
describe('NavTidyNotice (sub-nav popover)', () => {
  const NAV_TRIGGER_SELECTOR = '[aria-label="Navigation updated"]';
  const OPEN_DEFER_MS = 1500;
  const navTriggerCount = () => document.querySelectorAll(NAV_TRIGGER_SELECTOR).length;

  // The component hides one of these behind a feature flag; the notice only
  // nudges users who actually lost a nav item.
  const withHiddenNavItem = () => {
    mocks.state.features = { postsNavItem: false, eventsNavItem: true };
  };

  const renderWithSentinel = () =>
    renderWithProviders(
      <>
        <NavTidyNotice />
        <span data-testid="nav-tidy-sentinel">mounted</span>
      </>
    );

  /** Commit the tree, then let the open defer elapse. */
  const settle = async () => {
    await expect.element(page.getByTestId('nav-tidy-sentinel')).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, OPEN_DEFER_MS + 400));
  };

  test('renders its trigger and (after the open defer) its body when not dismissed', async () => {
    withHiddenNavItem();
    renderWithSentinel();

    // Positive control for every `navTriggerCount() === 0` below: the selector
    // CAN reach a non-zero count, so a zero elsewhere means absence, not a
    // selector that never matches anything.
    await settle();
    expect(navTriggerCount()).toBe(1);
    await expect.element(page.getByRole('button', { name: 'Navigation updated' })).toBeVisible();
    await expect.element(page.getByText('We tidied up the nav')).toBeVisible();
  });

  test('renders nothing when the notice id is already in dismissedAlerts', async () => {
    withHiddenNavItem();
    mocks.state.settings = { dismissedAlerts: ['nav-tidy-notice'] };
    renderWithSentinel();

    await settle();
    expect(navTriggerCount()).toBe(0);
  });

  test('renders nothing while `dismissedAlerts` is undefined (failed SSR snapshot)', async () => {
    withHiddenNavItem();
    mocks.state.settings = undefined;
    renderWithSentinel();

    await settle();
    expect(navTriggerCount()).toBe(0);
  });

  test('renders nothing when no nav item is hidden', async () => {
    mocks.state.features = { postsNavItem: true, eventsNavItem: true };
    renderWithSentinel();

    await settle();
    expect(navTriggerCount()).toBe(0);
  });

  test('dismissing persists `nav-tidy-notice`, updates the cache optimistically, and reconciles', async () => {
    withHiddenNavItem();
    renderWithSentinel();

    await expect.element(page.getByText('We tidied up the nav')).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Dismiss' }));

    await vi.waitFor(() => {
      expect(mocks.state.mutateCalls).toEqual([{ alertId: 'nav-tidy-notice' }]);
      // Optimistic write landed in the cache...
      expect(mocks.state.settings?.dismissedAlerts).toEqual(['nav-tidy-notice']);
      // ...and the truncated-settings reconcile fired exactly once.
      expect(mocks.state.invalidateCount).toBe(1);
    });
    // And the optimistic write alone takes it off screen — no server round-trip.
    // Safe as a `waitFor` because the tree is already committed and the notice
    // was VISIBLE a moment ago, so this is a transition, not a bare absence.
    await vi.waitFor(() => {
      expect(navTriggerCount()).toBe(0);
    });
  });
});

// -----------------------------------------------------------------------------
// YellowBuzzMigrationNotice — a Popover that WRAPS children in the app header.
// -----------------------------------------------------------------------------
describe('YellowBuzzMigrationNotice (children-wrapping header popover)', () => {
  const child = <span data-testid="wrapped-child">menu</span>;

  beforeEach(() => {
    mocks.state.features = { isGreen: true, buzz: true };
    mocks.state.yellow = 1234;
  });

  test('shows the notice alongside its children when the user holds yellow buzz', async () => {
    renderWithProviders(<YellowBuzzMigrationNotice>{child}</YellowBuzzMigrationNotice>);

    await expect.element(page.getByTestId('wrapped-child')).toBeVisible();
    await expect.element(page.getByText('Yellow Buzz has moved')).toBeVisible();
  });

  test('renders children unwrapped when dismissed — the child never disappears', async () => {
    mocks.state.settings = { dismissedAlerts: ['yellow-buzz-migration'] };
    renderWithProviders(<YellowBuzzMigrationNotice>{child}</YellowBuzzMigrationNotice>);

    await expect.element(page.getByTestId('wrapped-child')).toBeVisible();
    await vi.waitFor(() => {
      expect(page.getByText('Yellow Buzz has moved').elements()).toHaveLength(0);
    });
  });

  test('renders children unwrapped on a zero yellow balance', async () => {
    mocks.state.yellow = 0;
    renderWithProviders(<YellowBuzzMigrationNotice>{child}</YellowBuzzMigrationNotice>);

    await expect.element(page.getByTestId('wrapped-child')).toBeVisible();
    await vi.waitFor(() => {
      expect(page.getByText('Yellow Buzz has moved').elements()).toHaveLength(0);
    });
  });

  test('renders children unwrapped while `dismissedAlerts` is undefined', async () => {
    mocks.state.settings = undefined;
    renderWithProviders(<YellowBuzzMigrationNotice>{child}</YellowBuzzMigrationNotice>);

    await expect.element(page.getByTestId('wrapped-child')).toBeVisible();
    await vi.waitFor(() => {
      expect(page.getByText('Yellow Buzz has moved').elements()).toHaveLength(0);
    });
  });

  test('dismissing persists `yellow-buzz-migration` and leaves the children mounted', async () => {
    renderWithProviders(<YellowBuzzMigrationNotice>{child}</YellowBuzzMigrationNotice>);

    await expect.element(page.getByText('Yellow Buzz has moved')).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Dismiss' }));

    await vi.waitFor(() => {
      expect(mocks.state.mutateCalls).toEqual([{ alertId: 'yellow-buzz-migration' }]);
      expect(mocks.state.settings?.dismissedAlerts).toEqual(['yellow-buzz-migration']);
      expect(mocks.state.invalidateCount).toBe(1);
    });
    await expect.element(page.getByTestId('wrapped-child')).toBeVisible();
  });
});

// -----------------------------------------------------------------------------
// OnrampGuidance — inline page card, and the ONLY notice with a restore path.
// -----------------------------------------------------------------------------
describe('OnrampGuidance + OnrampGuidanceToggle (page card with restore)', () => {
  const bothMounted = (
    <>
      <OnrampGuidance />
      <OnrampGuidanceToggle />
    </>
  );

  test('card shows and the restore toggle is absent when not dismissed', async () => {
    renderWithProviders(bothMounted);

    await expect.element(page.getByRole('heading', { name: 'New to crypto?' })).toBeVisible();
    await vi.waitFor(() => {
      expect(
        page.getByRole('button', { name: 'New to crypto? Show guide' }).elements()
      ).toHaveLength(0);
    });
  });

  test('card hides and the restore toggle appears once dismissed', async () => {
    mocks.state.settings = { dismissedAlerts: ['crypto-onramp-guidance'] };
    renderWithProviders(bothMounted);

    await expect
      .element(page.getByRole('button', { name: 'New to crypto? Show guide' }))
      .toBeVisible();
    await vi.waitFor(() => {
      expect(page.getByRole('heading', { name: 'New to crypto?' }).elements()).toHaveLength(0);
    });
  });

  test('dismissing persists `crypto-onramp-guidance` and swaps card for toggle', async () => {
    renderWithProviders(bothMounted);

    await expect.element(page.getByRole('heading', { name: 'New to crypto?' })).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Dismiss' }));

    await vi.waitFor(() => {
      expect(mocks.state.mutateCalls).toEqual([{ alertId: 'crypto-onramp-guidance' }]);
      expect(mocks.state.settings?.dismissedAlerts).toEqual(['crypto-onramp-guidance']);
      expect(mocks.state.invalidateCount).toBe(1);
    });
    await expect
      .element(page.getByRole('button', { name: 'New to crypto? Show guide' }))
      .toBeVisible();
  });

  test('restoring sends `dismiss: false`, removes the id, and brings the card back', async () => {
    mocks.state.settings = { dismissedAlerts: ['other-alert', 'crypto-onramp-guidance'] };
    renderWithProviders(bothMounted);

    await userEvent.click(page.getByRole('button', { name: 'New to crypto? Show guide' }));

    await vi.waitFor(() => {
      expect(mocks.state.mutateCalls).toEqual([
        { alertId: 'crypto-onramp-guidance', dismiss: false },
      ]);
      // Only this id is removed — an unrelated dismissal must survive.
      expect(mocks.state.settings?.dismissedAlerts).toEqual(['other-alert']);
      expect(mocks.state.invalidateCount).toBe(1);
    });
    await expect.element(page.getByRole('heading', { name: 'New to crypto?' })).toBeVisible();
  });

  test('an unknown id in dismissedAlerts does not dismiss this notice', async () => {
    mocks.state.settings = { dismissedAlerts: ['crypto-onramp-guidance-v2', 'nav-tidy-notice'] };
    renderWithProviders(bothMounted);

    await expect.element(page.getByRole('heading', { name: 'New to crypto?' })).toBeVisible();
  });
});
