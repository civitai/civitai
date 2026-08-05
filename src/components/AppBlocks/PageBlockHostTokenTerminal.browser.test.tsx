import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useState } from 'react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W10 run page — MID-SESSION credential loss.
 *
 * 🔴 THE DEFECT. The `tokenError` effect only transitioned a host still in
 * `loading`. So a token that died AFTER the block went `ready` did nothing at
 * all: the host stayed `ready` holding nothing, the `TOKEN_REFRESH` push
 * early-returns on `!token`, and the block kept its now-dead credential and
 * silently 401'd every call — no signal to the user, none to the platform.
 *
 * 🔴 THE FIX IS DELIBERATELY GATED ON A *SETTLED* FAILURE (`tokenTerminal`), not
 * on a bare `tokenError`. `useBlockToken` now retries a failed refresh on a
 * bounded backoff and KEEPS a still-valid token while it does, so a transient
 * blip must never reach here. Escalating on `tokenError` would rip a working app
 * out from under the user for a two-second network hiccup — trading a silent
 * failure for a louder, more destructive one.
 *
 * 🔴 AND IT MUST NOT DOUBLE-COUNT. PR #3480 established the contract: ONE beacon
 * per host MOUNT, reporting the outcome the host settles on. A page that reached
 * `ready` already emitted its `ok`; escalating later must emit nothing further.
 *
 * This suite renders the REAL host with REAL hooks and REAL timers, mirroring
 * PageBlockHostAutoRetry — only the ambient tRPC client and useCurrentUser are
 * stubbed (the network/session Context the offline scaffold can't provide, NOT
 * the condition under test).
 */

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', () => ({
  // FeatureFlagsProvider statically imports this; a wholesale module mock MUST
  // re-declare it or the ESM link fails.
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    generation: { resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyViewer: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzTransactions: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzAccounts: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyDailyCompensation: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      queryAppWorkflows: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelAppWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      publishGenerationOutputs: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getImagesByIds: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    apps: {
      shared: {
        append: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        update: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        vote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        unvote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        withdraw: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        report: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
      storage: {
        set: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        delete: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
    },
    useUtils: () => ({
      apps: {
        shared: {
          list: { fetch: vi.fn() },
          getCount: { fetch: vi.fn() },
          getCounts: { fetch: vi.fn() },
          get: { fetch: vi.fn() },
        },
        storage: {
          get: { fetch: vi.fn() },
          list: { fetch: vi.fn() },
          getQuota: { fetch: vi.fn() },
        },
      },
    }),
  },
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'my-page-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Budgeted Generator',
  iframeSrc: SAME_ORIGIN_SRC,
  // The public run surface. Required since the init-fragment gate keys on it.
  surface: 'page-run' as const,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'my-page-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: ['apps:storage:read'],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' },
  theme: 'light' as const,
};

let fetchSpy: ReturnType<typeof vi.spyOn>;
const isBeacon = (call: unknown[]) =>
  typeof call[0] === 'string' && (call[0] as string).includes('/api/track/block-render');
const beaconCalls = () => fetchSpy.mock.calls.filter(isBeacon);
const beaconBodies = (): Array<{ status?: string; errorClass?: string; secondary?: boolean }> =>
  beaconCalls().map((c: unknown[]) => {
    const init = c[1] as RequestInit | undefined;
    return JSON.parse(String(init?.body ?? '{}')) as {
      status?: string;
      errorClass?: string;
      secondary?: boolean;
    };
  });
const beaconStatuses = (): string[] => beaconBodies().map((b) => b.status ?? 'ok');

beforeEach(() => {
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
});
afterEach(() => {
  fetchSpy.mockRestore();
});

function postFromBlock(type: string, payload?: unknown) {
  const iframeEl = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
  const cw = iframeEl.contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type, payload },
      origin: window.location.origin,
      source: cw,
    })
  );
}

async function driveToReady() {
  await vi.waitFor(() => {
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (!el.contentWindow) throw new Error('not mounted yet');
  });
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (el.getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

const fallbackQuery = () => page.getByTestId('app-page-fallback').query();
const iframeQuery = () => page.getByTestId('app-page-iframe').query();

describe('a READY page with a transient token failure', () => {
  test('🔴 is NOT torn down while recovery is still pending', async () => {
    const { rerender } = await renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={vi.fn()} />
    );
    await driveToReady();
    expect(beaconCalls()).toHaveLength(1);

    // The upstream hook is retrying: it reports the failure (`tokenError`) but has
    // NOT settled, so `tokenTerminal` stays false. Even with the token already
    // gone, the running app must be left alone.
    await rerender(
      <PageBlockHost
        {...baseProps}
        token={null}
        tokenError
        tokenTerminal={false}
        onConsentGranted={vi.fn()}
        onRetryToken={vi.fn()}
      />
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(fallbackQuery()).toBeNull();
    expect(iframeQuery()).not.toBeNull();
    expect(beaconCalls()).toHaveLength(1);
  });

  test('is untouched when the hook RETAINED a live token through the blip', async () => {
    const { rerender } = await renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={vi.fn()} />
    );
    await driveToReady();

    // The common case: refresh failed, but the held credential is still valid, so
    // the hook keeps serving it. `tokenError` is set; the page must ignore it.
    await rerender(
      <PageBlockHost
        {...baseProps}
        tokenError
        tokenTerminal={false}
        onConsentGranted={vi.fn()}
        onRetryToken={vi.fn()}
      />
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(fallbackQuery()).toBeNull();
    expect(beaconCalls()).toHaveLength(1);
  });
});

describe('a READY page whose credential is GONE for good', () => {
  test('🔴 escalates to the real terminal state instead of silently 401ing', async () => {
    const onRetryToken = vi.fn();
    const { rerender } = await renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={onRetryToken} />
    );
    await driveToReady();

    await rerender(
      <PageBlockHost
        {...baseProps}
        token={null}
        tokenError
        tokenTerminal
        onConsentGranted={vi.fn()}
        onRetryToken={onRetryToken}
      />
    );

    // The user now SEES the failure and has a way forward — previously the page
    // just sat there looking fine while every call 401'd.
    await expect.element(page.getByTestId('app-page-fallback')).toBeInTheDocument();
    expect(document.querySelector('[data-block-fallback="token_error"]')).not.toBeNull();
    expect(document.querySelector('[data-block-fallback-retry="true"]')).not.toBeNull();
  });

  test('🔴 REPORTS the teardown — exactly one extra beacon, tagged as a credential loss', async () => {
    /**
     * 🔴 THIS ASSERTION IS INVERTED FROM WHAT IT ORIGINALLY SAID, deliberately.
     *
     * It used to assert `['ok']` — no second beacon — on the reasoning that the
     * page LOAD did succeed and a second beacon would corrupt the impression
     * denominator. The load-succeeded half is still true (and still asserted:
     * the first beacon is untouched). The no-second-beacon half was a MEASURED
     * production defect: on 2026-07-31 a real revocation teardown was driven
     * against a live app and the platform recorded ZERO error beacons for it.
     * Its only record of the incident was that `ok` impression, so every render
     * metric read "healthy" while the app was dead in the viewer's tab.
     *
     * The fix does NOT relax the impression latch (that would retroactively
     * change what the `ok` means). The teardown gets its OWN at-most-once latch
     * and its OWN error class, so the two events stay separable: one `ok` (the
     * load) plus one `error{token_lost_midsession}` (the revocation).
     */
    const { rerender } = await renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={vi.fn()} />
    );
    await driveToReady();
    expect(beaconStatuses()).toEqual(['ok']);

    await rerender(
      <PageBlockHost
        {...baseProps}
        token={null}
        tokenError
        tokenTerminal
        onConsentGranted={vi.fn()}
        onRetryToken={vi.fn()}
      />
    );
    await expect.element(page.getByTestId('app-page-fallback')).toBeInTheDocument();
    // Let #3480's bounded auto-retry run its whole course too — the re-arm walks
    // back through 'loading' and lands on 'error' again, which is exactly the
    // re-entry the at-most-once latch has to absorb.
    await new Promise((r) => setTimeout(r, 9_000));

    // Exactly TWO, in order, and the impression is still the untouched `ok`.
    expect(beaconStatuses()).toEqual(['ok', 'error']);
    const bodies = beaconBodies();
    // The original impression is byte-identical to before: no status, no class,
    // and NOT flagged secondary — it is the mount's first beacon and must still
    // write its ClickHouse impression row.
    expect(bodies[0].status).toBeUndefined();
    expect(bodies[0].errorClass).toBeUndefined();
    expect(bodies[0].secondary).toBeUndefined();
    // The teardown carries the class that makes it distinguishable from a launch
    // failure ('error'/'no_token'/'timeout'/'fatal') in `sum by(error_class)`.
    //
    // 🔴 …and `secondary: true`, WITHOUT which the server would write a second
    // byte-identical `blockRenders` row for this one mount, inflating every
    // CH-derived impression figure for revoked sessions.
    expect(bodies[1]).toMatchObject({
      status: 'error',
      errorClass: 'token_lost_midsession',
      secondary: true,
    });
  }, 20_000);

  test('🔴 emits the teardown beacon AT MOST ONCE despite the host RE-ENTERING `error`', async () => {
    /**
     * 🔴 THIS IS THE TEST THAT PROVES THE LATCH IS REACHABLE, and it has to drive
     * a REAL re-entry to do it. Re-rendering with identical props does NOT
     * exercise the latch — the effect's deps are unchanged, so React never
     * re-runs it and the assertion passes with the latch deleted (verified: an
     * earlier version of this test did exactly that and stayed green under a
     * mutation that defeated the latch entirely).
     *
     * The re-entry that actually happens in production is the bounded auto-retry:
     * a re-mint ATTEMPT briefly clears the failure props (host → 'loading'), the
     * mint fails again, and the host lands back on 'error'. Without the per-mount
     * latch that second pass emits a second beacon for ONE incident — which is
     * how a single revocation would inflate the failure count.
     */
    function Harness({ dead }: { dead: boolean }) {
      const [failing, setFailing] = useState(true);
      const gone = dead && failing;
      return (
        <PageBlockHost
          {...baseProps}
          token={dead ? null : baseProps.token}
          tokenError={gone}
          tokenTerminal={gone}
          onConsentGranted={vi.fn()}
          onRetryToken={() => {
            // Mirrors useBlockToken.refresh: an attempt clears the terminal, then
            // it re-fails — walking the host error → loading → error.
            setFailing(false);
            setTimeout(() => setFailing(true), 10);
          }}
        />
      );
    }

    const { rerender } = await renderWithProviders(<Harness dead={false} />);
    await driveToReady();
    expect(beaconStatuses()).toEqual(['ok']);

    await rerender(<Harness dead />);
    await expect.element(page.getByTestId('app-page-fallback')).toBeInTheDocument();
    // Long enough for the whole bounded auto-retry sequence to run and re-enter.
    await new Promise((r) => setTimeout(r, 9_000));

    expect(beaconStatuses()).toEqual(['ok', 'error']);
  }, 20_000);

  test("re-arms #3480's bounded auto-retry, which re-mints ONCE then settles", async () => {
    /**
     * Drives the re-mint loop the way the real route does. `onRetryToken` is
     * `useBlockToken.refresh`, so a re-mint ATTEMPT briefly clears the failure
     * props and then fails again — which is what re-reaches the terminal fast
     * instead of waiting out the 15s token-wait window. An inert `vi.fn()` here
     * would leave the props frozen and the host parked in `loading`, testing
     * nothing.
     */
    function Harness({ dead, onRemint }: { dead: boolean; onRemint: () => void }) {
      const [failing, setFailing] = useState(true);
      const gone = dead && failing;
      return (
        <PageBlockHost
          {...baseProps}
          token={dead ? null : baseProps.token}
          tokenError={gone}
          tokenTerminal={gone}
          onConsentGranted={vi.fn()}
          onRetryToken={() => {
            onRemint();
            setFailing(false);
            setTimeout(() => setFailing(true), 10);
          }}
        />
      );
    }

    const onRemint = vi.fn();
    const { rerender } = await renderWithProviders(<Harness dead={false} onRemint={onRemint} />);
    await driveToReady();
    expect(onRemint).not.toHaveBeenCalled();

    await rerender(<Harness dead onRemint={onRemint} />);
    await expect.element(page.getByTestId('app-page-fallback')).toBeInTheDocument();

    // `error` is an AUTH terminal, so the one automatic attempt spends a re-mint…
    await vi.waitFor(
      () => {
        if (onRemint.mock.calls.length < 1) throw new Error('no automatic re-mint yet');
      },
      { timeout: 8_000 }
    );

    // …and then it SETTLES: bounded, never an unbounded auth loop against the
    // rate-limited mint endpoint. MAX_AUTO_REMINTS is 1.
    await new Promise((r) => setTimeout(r, 8_000));
    expect(onRemint.mock.calls.length).toBe(1);

    // What the user is left with: the real terminal message plus an UNMISSABLE
    // manual Retry — the path forward, never a dead end.
    expect(document.querySelector('[data-block-fallback="token_error"]')).not.toBeNull();
    expect(document.querySelector('[data-block-fallback-retry-prominent="true"]')).not.toBeNull();
    // And still exactly TWO beacons for the whole episode — the impression plus
    // ONE credential-loss report, no matter how many times the re-mint loop
    // re-enters the terminal.
    expect(beaconStatuses()).toEqual(['ok', 'error']);
  }, 25_000);
});

describe('app → app soft navigation (the host is NOT remounted)', () => {
  /**
   * 🔴 `/apps/run/[slug]` renders <PageBlockHost> with NO `key`, and `_app.tsx`
   * renders <Component> with no key either — so navigating appA → appB (the
   * "Recently run" menu) REUSES this component instance: same React mount, new
   * `blockInstanceId`.
   *
   * The credential-loss latches are per-MOUNT refs, so without scoping them to
   * the block instance they leak across that boundary and produce a WRONG,
   * MISATTRIBUTED signal: app B's LAUNCH failure inherits app A's
   * `reachedReady === true` and gets reported as `token_lost_midsession` for an
   * app that never launched — the exact launch-vs-teardown confusion this
   * feature exists to eliminate, now with the wrong app's id on it.
   *
   * (The wider host-reuse breakage — stale `status`, and app B losing its `ok`
   * impression to the leaked `blockRenderEmittedRef` — is PRE-EXISTING and not
   * fixed here. This only pins that the new signal cannot be misattributed.)
   */
  test('🔴 does NOT report app B’s launch failure as app A’s mid-session loss', async () => {
    const { rerender } = await renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={vi.fn()} />
    );
    await driveToReady();
    expect(beaconStatuses()).toEqual(['ok']);

    // Soft-navigate to a DIFFERENT app: same mount, new identifiers.
    const appB = {
      ...baseProps,
      appBlockId: 'apb_other',
      blockInstanceId: 'page_apb_other',
      blockId: 'other-page-app',
      slug: 'other-page-app',
    };

    // App B's mint fails terminally — it NEVER reached ready.
    await rerender(
      <PageBlockHost
        {...appB}
        token={null}
        tokenError
        tokenTerminal
        onConsentGranted={vi.fn()}
        onRetryToken={vi.fn()}
      />
    );
    await new Promise((r) => setTimeout(r, 9_000));

    // THE assertion: no `token_lost_midsession` may be attributed to app B.
    const midSession = beaconBodies().filter((b) => b.errorClass === 'token_lost_midsession');
    expect(midSession).toEqual([]);

    // And pin the FULL beacon set, which documents the pre-existing host-reuse
    // state this PR deliberately does NOT fix: app B emits NOTHING AT ALL — not
    // even its own launch-failure `error` — because `blockRenderEmittedRef` is
    // per-mount and was already spent by app A's impression, so the whole
    // soft-nav session is under-reported.
    //
    // Scope of that pin, stated exactly so it isn't misread: this test renders
    // PageBlockHost DIRECTLY and unkeyed, so it pins the HOST's behaviour under
    // instance reuse. Landing the real fix (`key={blockInstanceId}` on the run
    // page) would NOT fail this test — it removes the scenario in production
    // while this test keeps reproducing it here. The only change that would trip
    // `['ok']` is scoping `blockRenderEmittedRef` per instance, which this PR
    // reasons against above (the per-mount impression invariant). So it is
    // over-specified BY DESIGN and unlikely to obstruct the named follow-up.
    //
    // 🔴 Asserting the whole set matters: an earlier version of this test added a
    // second "nothing attributed to app B's id" filter that looked like an extra
    // guard but was VACUOUS — the filtered list is empty, so the assertion held
    // trivially and would have held with the fix deleted. This line pins the real
    // observable state instead.
    expect(beaconStatuses()).toEqual(['ok']);
  }, 20_000);
});

describe('backward compatibility', () => {
  test('🔴 omitting `tokenTerminal` leaves a ready page byte-identical', async () => {
    // Every pre-existing caller (ReviewBlockPreviewHost, the dev-tunnel page
    // before it was wired) passes no `tokenTerminal`. A ready page must behave
    // exactly as before: `tokenError` alone can never tear it down.
    const { rerender } = await renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={vi.fn()} />
    );
    await driveToReady();

    await rerender(
      <PageBlockHost
        {...baseProps}
        token={null}
        tokenError
        onConsentGranted={vi.fn()}
        onRetryToken={vi.fn()}
      />
    );
    await new Promise((r) => setTimeout(r, 100));

    expect(fallbackQuery()).toBeNull();
    expect(beaconCalls()).toHaveLength(1);
  });

  test('a LOADING page still escalates on `tokenError` alone (unchanged)', async () => {
    renderWithProviders(
      <PageBlockHost
        {...baseProps}
        token={null}
        tokenError
        onConsentGranted={vi.fn()}
        onRetryToken={vi.fn()}
      />
    );
    // Unchanged pre-existing behaviour: a hard mint failure before the block ever
    // loaded is terminal immediately, rather than waiting out the 15s token-wait.
    await expect.element(page.getByTestId('app-page-fallback')).toBeInTheDocument();
    expect(document.querySelector('[data-block-fallback="token_error"]')).not.toBeNull();
  });
});
