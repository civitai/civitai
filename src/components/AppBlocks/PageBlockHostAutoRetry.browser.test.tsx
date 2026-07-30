import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { page } from 'vitest/browser';
import { useEffect, useState } from 'react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import {
  AUTO_RETRY_BACKOFF_MS,
  MAX_AUTO_REMINTS,
  MAX_AUTO_RETRIES,
} from '~/components/AppBlocks/pageBlockHostLogic';

/**
 * W10 run-page BOUNDED AUTO-RETRY.
 *
 * The reported defect was NOT that the retry LOGIC was broken — it works — but
 * that recovery required the user to NOTICE a small button ("there might have
 * been a retry button but I didn't notice — I did a full page reload"). So the
 * host now re-attempts the load itself, bounded, and only then settles on a
 * definitive terminal state whose manual Retry is made prominent.
 *
 * 🔴 THE INVARIANTS THESE TESTS EXIST FOR
 *  1. BOUNDED, ALWAYS. The automatic loop stops after MAX_AUTO_RETRIES, and the
 *     AUTH terminals — the only ones that re-mint against the rate-limited
 *     `/api/v1/block-tokens` (60/min) — stop after MAX_AUTO_REMINTS.
 *  2. THE TERMINAL STATE IS NEVER MASKED OR DELAYED. The real error renders the
 *     instant the status goes terminal; the pending automatic attempt is shown
 *     INSIDE that same fallback. There is no "keep spinning quietly" state.
 *  3. ONE BEACON PER MOUNT describing the outcome the host SETTLES on: a load
 *     that succeeds on attempt 2 emits exactly one `ok` (never an `error` first);
 *     N failed automatic attempts emit ONE `error`, not N.
 *  4. NO TIMER LEAK. Unmounting mid-backoff must not fire the pending attempt.
 *  5. FRAME-1 still holds — every state stays wrapped in AppBlockChrome.
 *
 * 🔴 THIS SUITE EXERCISES THE REAL PATH. It renders the REAL PageBlockHost with
 * REAL hooks and REAL timers: no `@mantine/hooks` module mock (the reduced-motion
 * case stubs `window.matchMedia` so `useReducedMotion` itself still runs), and no
 * stub of the status machine. Only the ambient tRPC client + useCurrentUser are
 * stubbed, exactly as the sibling PageBlockHost suites do — those are the
 * network/session Context the offline scaffold can't provide, NOT the condition
 * under test. Mocking the retry decision or the media query as a constant would
 * remove the very thing being asserted.
 */

// AppBlockChrome calls useCurrentUser() for the platform-nav moderator gate; this
// suite renders the real host without a CivitaiSessionProvider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// PageBlockHost wires the money-path workflow bridge AND the storage bridge at
// render, which need the tRPC Context the network-free scaffold doesn't provide.
// Mirrors PageBlockHost.browser.test.tsx's stub — inert here.
vi.mock('~/utils/trpc', () => ({
  // FeatureFlagsProvider (in PageBlockHost's render graph) statically imports
  // this; a wholesale module mock MUST re-declare it or the ESM link fails.
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

// Same-origin so trustTier='internal' yields a pinned (non-opaque) transport
// whose expectedOrigin equals this frame's origin — see PageBlockHost.browser.test.
const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'my-page-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Budgeted Generator',
  iframeSrc: SAME_ORIGIN_SRC,
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

const FIRST_BACKOFF_MS = AUTO_RETRY_BACKOFF_MS[0];

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

/** Reach the `fatal` terminal fast (message-driven, no 10s/15s timer window). */
async function driveToFatal() {
  await driveToReady();
  postFromBlock('BLOCK_ERROR', { fatal: true });
  await expect.element(page.getByTestId('app-page-fallback')).toBeInTheDocument();
}

const fallbackEl = () => page.getByTestId('app-page-fallback').query();
const autoRetryLine = () =>
  document.querySelector('[data-block-fallback-autoretry="true"]') as HTMLElement | null;
const retryButton = () =>
  document.querySelector('[data-block-fallback-retry="true"]') as HTMLButtonElement | null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drives the AUTH-failure loop the way the real route does: each `onRetryToken`
 * (the re-mint) briefly clears `tokenError` and then fails again, so the host's
 * `error` terminal is re-reached fast instead of waiting out the 15s token-wait
 * window. That keeps the RE-MINT CAP test — the rate-limit guard — a few seconds
 * instead of a minute, while still going through the host's real status machine.
 */
function AuthFailureHarness({
  onRemint,
  mounted = true,
}: {
  onRemint: () => void;
  mounted?: boolean;
}) {
  const [failing, setFailing] = useState(true);
  if (!mounted) return null;
  return (
    <PageBlockHost
      {...baseProps}
      token={null}
      tokenError={failing}
      onConsentGranted={vi.fn()}
      onRetryToken={() => {
        onRemint();
        // Simulate a re-mint that is attempted and fails again ~immediately.
        setFailing(false);
        setTimeout(() => setFailing(true), 10);
      }}
    />
  );
}

describe('PageBlockHost auto-retry — fires from a terminal state, bounded and backed off', () => {
  test('a terminal state renders the REAL error IMMEDIATELY, with the pending retry shown inside it', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={vi.fn()} />);
    await driveToReady();

    const firedAt = Date.now();
    postFromBlock('BLOCK_ERROR', { fatal: true });

    // 🔴 The terminal message is NOT delayed by the auto-retry: it must land well
    // inside the backoff window. This is the assertion that fails if a future
    // change ever holds the surface in "loading" while it quietly retries.
    await vi.waitFor(() => expect(fallbackEl()).not.toBeNull(), { timeout: 2_000, interval: 5 });
    expect(Date.now() - firedAt).toBeLessThan(FIRST_BACKOFF_MS);

    // The real terminal copy is on screen …
    await expect.element(page.getByText('Budgeted Generator failed to load')).toBeInTheDocument();
    // … alongside the in-progress feedback (attempt 1 of N) …
    const line = autoRetryLine();
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain(`attempt 1 of ${MAX_AUTO_RETRIES}`);
    // … and the manual affordance stays available the whole time.
    expect(retryButton()).not.toBeNull();
    // FRAME-1: provenance chrome still wraps it.
    await expect.element(page.getByTestId('app-block-chrome')).toBeInTheDocument();
  });

  test('the automatic attempt actually re-runs the load after the backoff (and says so)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={vi.fn()} />);
    await driveToFatal();
    // Still in the terminal state for the whole backoff — the retry is NOT instant
    // (a 0ms "backoff" would be a hot loop against a down host).
    await sleep(Math.floor(FIRST_BACKOFF_MS / 2));
    expect(fallbackEl()).not.toBeNull();

    // …then the host re-attempts on its own: back to the loading surface, with a
    // fresh iframe, and copy that names the attempt (the "did the button do
    // anything?" half of the report).
    await vi.waitFor(() => expect(page.getByTestId('app-page-loading').query()).not.toBeNull(), {
      timeout: FIRST_BACKOFF_MS + 4_000,
      interval: 50,
    });
    await expect.element(page.getByText(/Retrying Budgeted Generator… \(attempt 2\)/)).toBeInTheDocument();
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    expect(el.getAttribute('data-block-ready')).toBe('false');
  }, 20_000);

  test(
    'auto-retry also fires from the `timeout` terminal (block never acks BLOCK_READY)',
    async () => {
      renderWithProviders(
        <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={vi.fn()} />
      );
      // ~10s readiness window → 'timeout'.
      await vi.waitFor(() => expect(fallbackEl()).not.toBeNull(), {
        timeout: 13_000,
        interval: 250,
      });
      expect(autoRetryLine()?.textContent).toContain(`attempt 1 of ${MAX_AUTO_RETRIES}`);
    },
    25_000
  );

  test(
    'auto-retry also fires from the `no_token` terminal, and it RE-MINTS',
    async () => {
      const onRetryToken = vi.fn();
      renderWithProviders(
        <PageBlockHost
          {...baseProps}
          token={null}
          tokenError={false}
          onConsentGranted={vi.fn()}
          onRetryToken={onRetryToken}
        />
      );
      // ~15s token-wait window → 'no_token'.
      await vi.waitFor(() => expect(fallbackEl()).not.toBeNull(), {
        timeout: 19_000,
        interval: 250,
      });
      expect(onRetryToken).not.toHaveBeenCalled();
      // An auth terminal can ONLY be recovered by re-minting (the token is an
      // upstream prop) — so the automatic attempt must re-mint, not just remount.
      await vi.waitFor(() => expect(onRetryToken).toHaveBeenCalledTimes(1), {
        timeout: FIRST_BACKOFF_MS + 4_000,
        interval: 50,
      });
    },
    30_000
  );

  test('a NON-auth terminal auto-retries WITHOUT re-minting (the token was fine)', async () => {
    const onRetryToken = vi.fn();
    renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={onRetryToken} />
    );
    await driveToFatal();
    await vi.waitFor(() => expect(page.getByTestId('app-page-loading').query()).not.toBeNull(), {
      timeout: FIRST_BACKOFF_MS + 4_000,
      interval: 50,
    });
    // The block crashed; the token was never the problem. Re-minting here would
    // burn the rate-limited endpoint for nothing.
    expect(onRetryToken).not.toHaveBeenCalled();
  }, 20_000);
});

describe('PageBlockHost auto-retry — survives an UNSTABLE onRetryToken prop', () => {
  // 🔴 REGRESSION GUARD for a real bug found while writing these tests: the backoff
  // timer must not be keyed on the `onRetryToken` callback IDENTITY. A caller may
  // pass an inline arrow, which is a new function every parent render — if the
  // scheduling effect depended on it, every re-render would tear down and re-arm
  // the pending timer, the backoff would never elapse, and auto-retry would
  // SILENTLY NEVER FIRE. The host reads the retry through a ref so the effect is
  // keyed on the decision alone.
  test('auto-retry still fires while the parent re-renders with a fresh callback each time', async () => {
    const onRemint = vi.fn();
    function ChurningParent() {
      const [, setTick] = useState(0);
      // Re-render faster than the backoff; each render hands the host a NEW
      // `onRetryToken` identity (an inline arrow, the shape a caller may well use).
      useEffect(() => {
        const id = setInterval(() => setTick((t) => t + 1), 100);
        return () => clearInterval(id);
      }, []);
      return (
        <PageBlockHost
          {...baseProps}
          token={null}
          tokenError
          onConsentGranted={vi.fn()}
          onRetryToken={() => onRemint()}
        />
      );
    }
    renderWithProviders(<ChurningParent />);

    await vi.waitFor(() => expect(autoRetryLine()).not.toBeNull(), {
      timeout: 5_000,
      interval: 50,
    });
    // The attempt must still land despite ~20 re-renders during the backoff.
    await vi.waitFor(() => expect(onRemint).toHaveBeenCalled(), {
      timeout: FIRST_BACKOFF_MS + 5_000,
      interval: 50,
    });
  }, 20_000);
});

describe('PageBlockHost auto-retry — the caps (unbounded loops are the failure mode)', () => {
  test(
    'AUTH terminals re-mint AT MOST MAX_AUTO_REMINTS times, then stop',
    async () => {
      const onRemint = vi.fn();
      renderWithProviders(<AuthFailureHarness onRemint={onRemint} />);

      // The host burns its automatic budget …
      await vi.waitFor(() => expect(onRemint).toHaveBeenCalledTimes(MAX_AUTO_REMINTS), {
        timeout: 25_000,
        interval: 100,
      });

      // 🔴 …and then STOPS. Waiting well past another full backoff must produce no
      // further re-mint. This is the rate-limit guard: `/api/v1/block-tokens` is
      // 60/min, and an unbounded auth-failure loop is exactly the shape that
      // would burn it.
      await sleep(AUTO_RETRY_BACKOFF_MS[AUTO_RETRY_BACKOFF_MS.length - 1] + 3_000);
      expect(onRemint).toHaveBeenCalledTimes(MAX_AUTO_REMINTS);
    },
    45_000
  );

  test(
    'after exhaustion the host settles on a DEFINITIVE terminal state with a PROMINENT manual Retry',
    async () => {
      const onRemint = vi.fn();
      renderWithProviders(<AuthFailureHarness onRemint={onRemint} />);
      await vi.waitFor(() => expect(onRemint).toHaveBeenCalledTimes(MAX_AUTO_REMINTS), {
        timeout: 25_000,
        interval: 100,
      });

      // Settle: the pending-retry line is gone and the fallback is final.
      await vi.waitFor(
        () => {
          expect(fallbackEl()).not.toBeNull();
          expect(autoRetryLine()).toBeNull();
        },
        { timeout: 20_000, interval: 100 }
      );

      // 🔴 THE ACTUAL REPORTED FAILURE: the manual affordance must now be
      // impossible to miss. It is filled + full-width rather than the small
      // subdued default, and the host says plainly that it already tried.
      const btn = retryButton();
      expect(btn).not.toBeNull();
      expect(btn?.getAttribute('data-block-fallback-retry-prominent')).toBe('true');
      await expect
        .element(page.getByText(`We already retried ${MAX_AUTO_RETRIES} times automatically.`))
        .toBeInTheDocument();
      // Still reachable by its stable accessible name, and still inside the chrome.
      await expect.element(page.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      await expect.element(page.getByTestId('app-block-chrome')).toBeInTheDocument();
    },
    60_000
  );
});

describe('PageBlockHost auto-retry — beacon semantics (one per mount, the settled outcome)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function isBeacon(call: unknown[]) {
    return typeof call[0] === 'string' && (call[0] as string).includes('/api/track/block-render');
  }
  function beaconCalls() {
    return fetchSpy.mock.calls.filter(isBeacon);
  }
  function beaconBodies() {
    return beaconCalls().map((c: unknown[]) => JSON.parse(String((c[1] as RequestInit).body)));
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    fetchSpy.mockClear();
  });

  test(
    'success on attempt 2 emits EXACTLY ONE `ok` beacon — and no `error` first',
    async () => {
      renderWithProviders(
        <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={vi.fn()} />
      );

      // Attempt 1 fails by never acking → 'timeout'. It must emit NOTHING (an
      // automatic attempt is still coming — the host has not settled).
      await vi.waitFor(() => expect(fallbackEl()).not.toBeNull(), {
        timeout: 13_000,
        interval: 250,
      });
      expect(beaconCalls()).toHaveLength(0);

      // Attempt 2 succeeds.
      await vi.waitFor(() => expect(page.getByTestId('app-page-loading').query()).not.toBeNull(), {
        timeout: FIRST_BACKOFF_MS + 4_000,
        interval: 50,
      });
      await driveToReady();

      await vi.waitFor(() => expect(beaconCalls()).toHaveLength(1));
      const [body] = beaconBodies();
      // The `ok` beacon carries no `status` field (see sendBlockRender).
      expect(body).toEqual({
        appBlockId: 'apb_test',
        blockInstanceId: 'page_apb_test',
        slotId: 'app.page',
      });
      // Give any stray emit a chance to show up before asserting exclusivity.
      await sleep(300);
      expect(beaconCalls()).toHaveLength(1);
    },
    30_000
  );

  test(
    'a mount that already reported `ok` never additionally reports `error` after a crash + failed recovery',
    async () => {
      // 🔴 THE EMIT-ONCE GUARD. `performRetry` must NOT reset
      // `blockRenderEmittedRef` — a retry is part of the SAME mount, so the mount
      // keeps its already-reported outcome. Resetting it re-opens the beacon and
      // a single page load reports BOTH `ok` and `error`, double-counting in the
      // denominator AND inflating the failure ratio the alert watches.
      //
      // (Mutation-verified: re-adding `blockRenderEmittedRef.current = false` to
      // performRetry fails THIS test. The sibling "N failed attempts emit ONE
      // error" test does NOT catch it — the settled-gate alone keeps that path to
      // one beacon — which is why this case exists separately.)
      renderWithProviders(
        <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={vi.fn()} />
      );

      // Load succeeds → exactly one `ok`.
      await driveToReady();
      await vi.waitFor(() => expect(beaconCalls()).toHaveLength(1));
      expect(beaconBodies()[0]).not.toHaveProperty('status');

      // Then the block crashes and every automatic recovery attempt fails
      // (the fresh frames never ack, so each rides the readiness timeout).
      postFromBlock('BLOCK_ERROR', { fatal: true });
      await vi.waitFor(
        () => {
          expect(fallbackEl()).not.toBeNull();
          expect(autoRetryLine()).toBeNull(); // settled: budget spent
        },
        { timeout: 40_000, interval: 250 }
      );

      // Still exactly the one `ok` — no `error` beacon was re-opened.
      expect(beaconCalls()).toHaveLength(1);
      expect(beaconBodies()[0]).not.toHaveProperty('status');
    },
    60_000
  );

  test(
    'N failed automatic attempts emit ONE `error` beacon, not N',
    async () => {
      const onRemint = vi.fn();
      renderWithProviders(<AuthFailureHarness onRemint={onRemint} />);

      // Burn the whole automatic budget.
      await vi.waitFor(() => expect(onRemint).toHaveBeenCalledTimes(MAX_AUTO_REMINTS), {
        timeout: 25_000,
        interval: 100,
      });
      // Settle, then exactly ONE error beacon for the whole sequence.
      await vi.waitFor(() => expect(beaconCalls()).toHaveLength(1), {
        timeout: 20_000,
        interval: 100,
      });
      const [body] = beaconBodies();
      expect(body.status).toBe('error');
      // errorClass stays inside the server-side KNOWN_ERROR_CLASSES enum, so the
      // existing prom label + its alert are unchanged by auto-retry.
      expect(['error', 'no_token']).toContain(body.errorClass);

      await sleep(AUTO_RETRY_BACKOFF_MS[AUTO_RETRY_BACKOFF_MS.length - 1] + 2_000);
      expect(beaconCalls()).toHaveLength(1);
    },
    60_000
  );
});

describe('PageBlockHost auto-retry — reduced motion', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    // Stub the MEDIA QUERY, not the hook: `useReducedMotion` still runs for real,
    // so this exercises the actual code path rather than replacing it.
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      } as unknown as MediaQueryList)) as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  test('the retrying state renders with NO spinner under prefers-reduced-motion', async () => {
    renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={vi.fn()} />
    );
    await driveToFatal();

    const line = autoRetryLine();
    expect(line).not.toBeNull();
    // The COPY still carries the state (reduced motion removes motion, not info) …
    expect(line?.textContent).toContain(`attempt 1 of ${MAX_AUTO_RETRIES}`);
    // … but no animated Loader is rendered at all.
    expect(line?.getAttribute('data-block-fallback-autoretry-animate')).toBe('false');
    expect(line?.querySelector('.mantine-Loader-root')).toBeNull();
  });
});

describe('PageBlockHost auto-retry — manual Retry interaction + teardown', () => {
  test('a manual Retry DURING a pending auto-retry runs once and does not consume the automatic budget', async () => {
    const onRetryToken = vi.fn();
    renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={onRetryToken} />
    );
    await driveToFatal();
    expect(autoRetryLine()?.textContent).toContain('attempt 1 of');

    // Take over BEFORE the backoff elapses.
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();
    expect(fallbackEl()).toBeNull();

    // The pending automatic attempt was cancelled — driving straight back to a
    // terminal shows the budget still on attempt 1 (the user taking over must not
    // spend the platform's remaining recovery attempts), and no extra load ran.
    await driveToReady();
    postFromBlock('BLOCK_ERROR', { fatal: true });
    await vi.waitFor(() => expect(fallbackEl()).not.toBeNull());
    expect(autoRetryLine()?.textContent).toContain(`attempt 1 of ${MAX_AUTO_RETRIES}`);
    // `fatal` is not an auth failure → still no re-mint from either path.
    expect(onRetryToken).not.toHaveBeenCalled();
  }, 20_000);

  test(
    'unmounting mid-backoff leaks NO timer — the pending attempt never fires',
    async () => {
      const onRemint = vi.fn();
      function Harness() {
        const [mounted, setMounted] = useState(true);
        return (
          <>
            <button type="button" data-testid="unmount-host" onClick={() => setMounted(false)}>
              unmount
            </button>
            <AuthFailureHarness onRemint={onRemint} mounted={mounted} />
          </>
        );
      }
      renderWithProviders(<Harness />);

      // An auth terminal is reached and an automatic re-mint is scheduled …
      await vi.waitFor(() => expect(autoRetryLine()).not.toBeNull(), {
        timeout: 5_000,
        interval: 50,
      });

      // … unmount before the backoff elapses.
      await page.getByTestId('unmount-host').click();
      await vi.waitFor(() => expect(page.getByTestId('app-page-frame').query()).toBeNull());
      // Snapshot AT unmount rather than asserting zero beforehand: on a slow box a
      // first automatic attempt may legitimately have already fired. The invariant
      // under test is that NOTHING fires AFTER unmount, and that holds either way.
      const remintsAtUnmount = onRemint.mock.calls.length;

      // 🔴 A leaked timer would fire the scheduled attempt after unmount — hitting
      // the rate-limited mint endpoint for a page nobody is looking at. Wait well
      // past the backoff and assert the count never grew.
      await sleep(FIRST_BACKOFF_MS + 2_000);
      expect(onRemint.mock.calls.length).toBe(remintsAtUnmount);
    },
    30_000
  );
});
