import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcUtils from '~/utils/trpc';

// =============================================================================
// The `useFeatureNotice` primitive, driven directly.
//
// The characterization suite covers three real mount contexts (sub-nav popover,
// children-wrapping header popover, inline page card). This file covers what
// those cannot reach:
//   * the ERRORED-settings path, where `isLoading` and `hasSettings` disagree —
//     the divergence that made `BuyBuzzModal` the odd one out
//   * rollback: a failed mutation restores the previous cache
//   * the restore direction removing only its own id
//   * the notice argument actually being READ (two notices, one hook)
// =============================================================================

const mocks = vi.hoisted(() => {
  const state = {
    settings: undefined as Record<string, any> | undefined,
    isLoading: false,
    currentUser: { id: 1 } as any,
    mutationFails: false,
    invalidateCount: 0,
    mutateCalls: [] as Array<{ alertId: string; dismiss?: boolean }>,
    queryEnabledSeen: [] as (boolean | undefined)[],
    /** The per-user flag overlay a notice's `audience` is resolved against. */
    features: {} as Record<string, boolean> | null,
    flagsReady: true,
  };

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

  const useDismissMutation = (opts: any) => ({
    mutate: (vars: { alertId: string; dismiss?: boolean }) => {
      state.mutateCalls.push(vars);
      void Promise.resolve(opts?.onMutate?.(vars)).then((ctx) => {
        if (state.mutationFails) opts?.onError?.(new Error('boom'), vars, ctx);
        opts?.onSettled?.(undefined, state.mutationFails ? new Error('boom') : null, vars, ctx);
      });
    },
    isPending: false,
    isLoading: false,
  });

  return { state, subscribe, snapshot, utils, useDismissMutation };
});

function useSettingsQuery(_input?: unknown, opts?: { enabled?: boolean }) {
  const data = React.useSyncExternalStore(mocks.subscribe, mocks.snapshot, mocks.snapshot);
  const enabled = opts?.enabled ?? true;
  mocks.state.queryEnabledSeen.push(opts?.enabled);
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
    useUtils: () => mocks.utils,
  },
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.state.currentUser,
}));

// `useFeatureNotice` reads the per-user flag overlay to answer a notice's
// `audience`. Mocked rather than left to the real provider so this file keeps
// controlling every input it asserts on — and because an export a consumer
// imports must exist in the factory or the file fails at COLLECTION, which
// reports as "no tests" instead of as a failure.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => mocks.state.features,
  useOptionalFeatureFlags: () => mocks.state.features,
  useFeatureFlagsReady: () => mocks.state.flagsReady,
}));

import { renderWithProviders } from '../../../../test/component-setup';
import { FEATURE_NOTICES } from '~/components/Alerts/notice-registry';
import { useFeatureNotice } from '~/components/Alerts/useFeatureNotice';

/** Minimal harness: renders the hook's whole state as assertable DOM state. */
function Probe({
  notice = FEATURE_NOTICES.navTidy,
  enabled,
  testId = 'probe',
}: {
  notice?: (typeof FEATURE_NOTICES)[keyof typeof FEATURE_NOTICES];
  enabled?: boolean;
  testId?: string;
}) {
  const { isDismissed, hasSettings, isLoading, isInAudience, dismiss, restore } = useFeatureNotice(
    notice,
    enabled === undefined ? undefined : { enabled }
  );
  return (
    <div
      data-testid={testId}
      // State is asserted via attributes, never via rendered words — a word can
      // be spelled by unrelated copy, an attribute pair cannot.
      data-dismissed={String(isDismissed)}
      data-has-settings={String(hasSettings)}
      data-loading={String(isLoading)}
      data-in-audience={String(isInAudience)}
    >
      <button type="button" onClick={dismiss} aria-label={`dismiss-${testId}`}>
        dismiss
      </button>
      <button type="button" onClick={restore} aria-label={`restore-${testId}`}>
        restore
      </button>
    </div>
  );
}

const probeState = async (testId = 'probe') => {
  // `.element()` is synchronous and throws if the tree has not mounted yet, so
  // wait for it rather than racing the first paint.
  await expect.element(page.getByTestId(testId)).toBeInTheDocument();
  const el = page.getByTestId(testId).element();
  return {
    dismissed: el.getAttribute('data-dismissed'),
    hasSettings: el.getAttribute('data-has-settings'),
    loading: el.getAttribute('data-loading'),
    inAudience: el.getAttribute('data-in-audience'),
  };
};

beforeEach(() => {
  mocks.state.settings = { dismissedAlerts: [] };
  mocks.state.isLoading = false;
  mocks.state.currentUser = { id: 1 };
  mocks.state.mutationFails = false;
  mocks.state.invalidateCount = 0;
  mocks.state.mutateCalls = [];
  mocks.state.queryEnabledSeen = [];
  mocks.state.features = {};
  mocks.state.flagsReady = true;
});

describe('useFeatureNotice — reading dismissed state', () => {
  test('not dismissed, settings resolved', async () => {
    renderWithProviders(<Probe />);
    expect(await probeState()).toEqual({
      dismissed: 'false',
      hasSettings: 'true',
      loading: 'false',
      inAudience: 'true',
    });
  });

  test('dismissed when the registered id is stored', async () => {
    mocks.state.settings = { dismissedAlerts: ['nav-tidy-notice'] };
    renderWithProviders(<Probe />);
    expect((await probeState()).dismissed).toBe('true');
  });

  test('the notice ARGUMENT is read — two probes, one stored id, different answers', async () => {
    mocks.state.settings = { dismissedAlerts: ['crypto-onramp-guidance'] };
    renderWithProviders(
      <>
        <Probe notice={FEATURE_NOTICES.cryptoOnrampGuidance} testId="onramp" />
        <Probe notice={FEATURE_NOTICES.navTidy} testId="navtidy" />
      </>
    );
    expect((await probeState('onramp')).dismissed).toBe('true');
    expect((await probeState('navtidy')).dismissed).toBe('false');
  });
});

describe('useFeatureNotice — hasSettings vs isLoading', () => {
  // 🔴 The distinction that separated the four copies. A settled-but-empty
  // settings read reports `isLoading: false` AND `hasSettings: false`. A caller
  // gating on `isLoading` renders; a caller gating on `hasSettings` does not.
  test('a settled-but-undefined settings read: isLoading false, hasSettings false', async () => {
    mocks.state.settings = undefined;
    mocks.state.isLoading = false;
    renderWithProviders(<Probe />);
    expect(await probeState()).toEqual({
      dismissed: 'false',
      hasSettings: 'false',
      loading: 'false',
      inAudience: 'true',
    });
  });

  test('an in-flight settings read: isLoading true, hasSettings false', async () => {
    mocks.state.settings = undefined;
    mocks.state.isLoading = true;
    renderWithProviders(<Probe />);
    expect(await probeState()).toEqual({
      dismissed: 'false',
      hasSettings: 'false',
      loading: 'true',
      inAudience: 'true',
    });
  });

  test('a resolved settings object with no dismissedAlerts key still counts as resolved', async () => {
    mocks.state.settings = {};
    renderWithProviders(<Probe />);
    expect(await probeState()).toEqual({
      dismissed: 'false',
      hasSettings: 'true',
      loading: 'false',
      inAudience: 'true',
    });
  });
});

describe('useFeatureNotice — query gating', () => {
  test('signed out disables the settings query regardless of the enabled option', async () => {
    mocks.state.currentUser = null;
    renderWithProviders(<Probe enabled />);
    expect(mocks.state.queryEnabledSeen.every((v) => v === false)).toBe(true);
    expect((await probeState()).hasSettings).toBe('false');
  });

  test('enabled:false disables the query even when signed in', async () => {
    renderWithProviders(<Probe enabled={false} />);
    expect(mocks.state.queryEnabledSeen.every((v) => v === false)).toBe(true);
  });

  test('signed in with no option leaves the query enabled', async () => {
    renderWithProviders(<Probe />);
    expect(mocks.state.queryEnabledSeen.every((v) => v === true)).toBe(true);
  });
});

describe('useFeatureNotice — writing', () => {
  test('dismiss sends the registered id with no explicit flag, appends it, and reconciles', async () => {
    renderWithProviders(<Probe />);
    await userEvent.click(page.getByRole('button', { name: 'dismiss-probe' }));

    await vi.waitFor(async () => {
      // Payload shape matters: the server schema defaults `dismiss` to true, and
      // this is the exact payload every call site sent before consolidation.
      expect(mocks.state.mutateCalls).toEqual([{ alertId: 'nav-tidy-notice' }]);
      expect(mocks.state.settings?.dismissedAlerts).toEqual(['nav-tidy-notice']);
      expect(mocks.state.invalidateCount).toBe(1);
      expect((await probeState()).dismissed).toBe('true');
    });
  });

  test('dismiss preserves unrelated settings keys and unrelated dismissals', async () => {
    mocks.state.settings = { dismissedAlerts: ['other'], hideModelsFrom: [7], someFlag: true };
    renderWithProviders(<Probe />);
    await userEvent.click(page.getByRole('button', { name: 'dismiss-probe' }));

    await vi.waitFor(() => {
      expect(mocks.state.settings).toEqual({
        dismissedAlerts: ['other', 'nav-tidy-notice'],
        hideModelsFrom: [7],
        someFlag: true,
      });
    });
  });

  test('restore sends dismiss:false and removes ONLY its own id', async () => {
    mocks.state.settings = { dismissedAlerts: ['a', 'nav-tidy-notice', 'b'] };
    renderWithProviders(<Probe />);
    await userEvent.click(page.getByRole('button', { name: 'restore-probe' }));

    await vi.waitFor(async () => {
      expect(mocks.state.mutateCalls).toEqual([{ alertId: 'nav-tidy-notice', dismiss: false }]);
      expect(mocks.state.settings?.dismissedAlerts).toEqual(['a', 'b']);
      expect(mocks.state.invalidateCount).toBe(1);
      expect((await probeState()).dismissed).toBe('false');
    });
  });

  test('restore on a notice that was never dismissed is a no-op on the array', async () => {
    mocks.state.settings = { dismissedAlerts: ['a'] };
    renderWithProviders(<Probe />);
    await userEvent.click(page.getByRole('button', { name: 'restore-probe' }));
    await vi.waitFor(() => {
      expect(mocks.state.settings?.dismissedAlerts).toEqual(['a']);
    });
  });

  test('a failed dismiss rolls the cache back to the previous value', async () => {
    mocks.state.mutationFails = true;
    mocks.state.settings = { dismissedAlerts: ['a'], someFlag: true };
    renderWithProviders(<Probe />);
    await userEvent.click(page.getByRole('button', { name: 'dismiss-probe' }));

    await vi.waitFor(async () => {
      expect(mocks.state.settings).toEqual({ dismissedAlerts: ['a'], someFlag: true });
      expect((await probeState()).dismissed).toBe('false');
      // The reconcile still fires on failure — that is what repairs a cache the
      // optimistic write may already have touched.
      expect(mocks.state.invalidateCount).toBe(1);
    });
  });

  test('a failed restore rolls the cache back — the notice stays dismissed', async () => {
    mocks.state.mutationFails = true;
    mocks.state.settings = { dismissedAlerts: ['nav-tidy-notice'] };
    renderWithProviders(<Probe />);
    await userEvent.click(page.getByRole('button', { name: 'restore-probe' }));

    await vi.waitFor(async () => {
      expect(mocks.state.settings?.dismissedAlerts).toEqual(['nav-tidy-notice']);
      expect((await probeState()).dismissed).toBe('true');
    });
  });

  test('dismissing on an UNRESOLVED cache does not fabricate a settings object beyond the id', async () => {
    // The truncated-settings hazard the reconcile exists for: the optimistic
    // write spreads `...old`, and `old` is undefined here.
    mocks.state.settings = undefined;
    renderWithProviders(<Probe />);
    await userEvent.click(page.getByRole('button', { name: 'dismiss-probe' }));

    await vi.waitFor(() => {
      expect(mocks.state.settings).toEqual({ dismissedAlerts: ['nav-tidy-notice'] });
      expect(mocks.state.invalidateCount).toBe(1);
    });
  });
});

describe('useFeatureNotice — audience targeting', () => {
  // 🔴 The same claim as `useFeatureNotice.audience.test.ts`, driven through a
  // real browser render instead of happy-dom. That file is the GATE (project
  // `unit`, which is what CI runs); this is the corroborating end-to-end pass.
  //
  // `remixGalleryExplainer` is the only registry entry that declares an
  // audience, and `navTidy` declares none — so the pair below moves BOTH ways
  // from one flag map, which a constant cannot do.
  const TARGETED = FEATURE_NOTICES.remixGalleryExplainer;
  const UNTARGETED = FEATURE_NOTICES.navTidy;

  test('a targeted notice is out of audience when its flag is off', async () => {
    mocks.state.features = { remixGallery: false };
    renderWithProviders(<Probe notice={TARGETED} testId="targeted" />);
    expect((await probeState('targeted')).inAudience).toBe('false');
  });

  test('a targeted notice is in audience when its flag is on', async () => {
    mocks.state.features = { remixGallery: true };
    renderWithProviders(<Probe notice={TARGETED} testId="targeted" />);
    expect((await probeState('targeted')).inAudience).toBe('true');
  });

  test('targeted and untargeted notices disagree under ONE flag map', async () => {
    // The strongest shape available here: one render, one set of flags, two
    // notices, opposite answers. An implementation that returned a constant —
    // or that read "is any flag on" — cannot produce this.
    mocks.state.features = { remixGallery: false, imageCardInfoButton: true };
    renderWithProviders(
      <>
        <Probe notice={TARGETED} testId="targeted" />
        <Probe notice={UNTARGETED} testId="untargeted" />
      </>
    );
    expect((await probeState('targeted')).inAudience).toBe('false');
    expect((await probeState('untargeted')).inAudience).toBe('true');
  });

  test('a targeted notice fails closed until the per-user overlay is ready', async () => {
    // The flags say the user IS in the audience; readiness is the only
    // variable. Announcing against the anonymous snapshot then retracting is
    // the flash this withholding exists to prevent.
    mocks.state.features = { remixGallery: true };
    mocks.state.flagsReady = false;
    renderWithProviders(<Probe notice={TARGETED} testId="targeted" />);
    expect((await probeState('targeted')).inAudience).toBe('false');
  });

  test('an untargeted notice is unaffected by readiness or by missing flags', async () => {
    // INVARIANT guard: pins that the eight untargeted notices are untouched by
    // targeting existing. Stays green if the audience branch is deleted.
    mocks.state.features = null;
    mocks.state.flagsReady = false;
    renderWithProviders(<Probe notice={UNTARGETED} testId="untargeted" />);
    expect((await probeState('untargeted')).inAudience).toBe('true');
  });

  test('audience does not disturb dismissal state', async () => {
    // The two gates are independent: out of audience is not "dismissed", and a
    // dismissal is still recorded against the notice's own id.
    mocks.state.features = { remixGallery: false };
    mocks.state.settings = { dismissedAlerts: [] };
    renderWithProviders(<Probe notice={TARGETED} testId="targeted" />);
    const state = await probeState('targeted');
    expect(state.inAudience).toBe('false');
    expect(state.dismissed).toBe('false');
    expect(state.hasSettings).toBe('true');
  });
});
