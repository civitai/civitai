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
 * REAL hooks: no `@mantine/hooks` module mock (the reduced-motion case stubs
 * `window.matchMedia` so `useReducedMotion` itself still runs), and no stub of the
 * status machine. Only the ambient tRPC client + useCurrentUser are stubbed,
 * exactly as the sibling PageBlockHost suites do — those are the network/session
 * Context the offline scaffold can't provide, NOT the condition under test.
 * Mocking the retry decision or the media query as a constant would remove the
 * very thing being asserted.
 *
 * 🔴 THE CLOCK IS VIRTUAL, THE BEHAVIOUR IS NOT.
 * The host's recovery windows are 10s (BLOCK_READY), 15s (token wait) and a
 * 2s/5s backoff. Sleeping through them for real cost this ONE file 99.5s of the
 * component suite's 25-minute CI budget — a third of it in a single test — and
 * budget exhaustion (rc=124, "no suite reported red") is what made the
 * `preview / component-tests` check red on 100% of PRs.
 *
 * So the eleven long tests install a VIRTUAL clock (`vi.useFakeTimers`, timer
 * functions only — `Date`, `performance`, `requestAnimationFrame` and
 * `queueMicrotask` are left real so React's scheduler and Mantine are untouched)
 * and JUMP those windows with `advance()`. Nothing about the host changes: the
 * same effects arm the same `setTimeout`s, the same status machine runs, the same
 * `performRetry` executes. What changes is only how long the test sits waiting.
 *
 * 🔴 AND THEY STILL DRIVE THE ASYNC PATH. A converted test that stopped
 * exercising the retry would look identical to one that passes, so every
 * converted case asserts the RETRY ACTUALLY RAN — a fresh loading surface, a
 * re-mint call count, a beacon count — not merely that nothing threw.
 *
 * THREE tests deliberately keep REAL timers: the two that assert an
 * already-instant render (nothing to wait for) and the manual-Retry case, which
 * uses a real Playwright `.click()` — driver interactions must not race a faked
 * clock, and that test costs 358ms as-is.
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
import {
  BLOCK_READY_TIMEOUT_MS,
  PageBlockHost,
  TOKEN_WAIT_TIMEOUT_MS,
} from '~/components/AppBlocks/PageBlockHost';

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
const LAST_BACKOFF_MS = AUTO_RETRY_BACKOFF_MS[AUTO_RETRY_BACKOFF_MS.length - 1];

/**
 * The REAL `setTimeout`, captured at module load — before any test installs the
 * virtual clock, so this binding is never the faked one. `pollFor` needs it: a
 * poll that only advances VIRTUAL time hands the browser almost no real time, so
 * anything genuinely asynchronous (an iframe mounting) can miss its window on a
 * loaded box while the poll burns its whole budget in milliseconds.
 */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realSleep = (ms: number) => new Promise((r) => realSetTimeout(r, ms));

/**
 * Install the VIRTUAL clock for one test (call it before `renderWithProviders`,
 * so the host's effects arm their timers against it).
 *
 * `toFake` is deliberately restricted to the timer functions. Leaving `Date`,
 * `performance`, `requestAnimationFrame` and `queueMicrotask` REAL keeps React's
 * scheduler (MessageChannel/rAF), Mantine's transitions and the browser driver
 * working exactly as they do under real timers — the only thing that becomes
 * virtual is how long a `setTimeout` takes to fire, which is the whole point.
 */
function useVirtualClock() {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
}

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Move time forward by `ms` and let React commit. Works under either clock, so
 * the helpers below are shared by the virtual-clock tests and the three
 * real-timer ones. Under the virtual clock the elapsed time is EXACT — that is
 * what makes the "not yet, then fired" boundary assertions deterministic instead
 * of a race against the runner.
 */
async function advance(ms: number) {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(ms);
    // Flush the promise/effect chain the fired timers kicked off. Each async
    // tick also yields a REAL macrotask, so the browser (iframe loads, React's
    // scheduler) makes progress even while virtual time stands still.
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
    return;
  }
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll `ready()`, nudging the clock in small steps.
 *
 * 🔴 Used ONLY for things that depend on real browser work — an iframe mounting,
 * a React commit landing. NEVER to wait out one of the host's recovery windows:
 * those are jumped with an explicit `advance(WINDOW)` so the test states exactly
 * how much time it believes has passed.
 *
 * Two budgets, deliberately decoupled: at most 500ms of VIRTUAL time (well inside
 * the shortest recovery window, 2s, so a poll can never silently trip the very
 * behaviour the test is about to assert) and up to 5s of REAL time for the
 * browser to actually do the work. Advancing virtual time alone would give the
 * page only microtasks — the failure mode that makes a fake-timer poll report
 * "iframe never mounted" on a saturated runner.
 */
async function pollFor(what: string, ready: () => boolean) {
  const fake = vi.isFakeTimers();
  for (let i = 0; i < 500; i++) {
    if (ready()) return;
    if (fake) {
      await advance(1);
      await realSleep(10);
    } else {
      await advance(20);
    }
  }
  throw new Error(`timed out waiting for: ${what}`);
}

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

const iframeEl = () => page.getByTestId('app-page-iframe').query() as HTMLIFrameElement | null;
const loadingEl = () => page.getByTestId('app-page-loading').query();
const fallbackEl = () => page.getByTestId('app-page-fallback').query();
const autoRetryLine = () =>
  document.querySelector('[data-block-fallback-autoretry="true"]') as HTMLElement | null;
const retryButton = () =>
  document.querySelector('[data-block-fallback-retry="true"]') as HTMLButtonElement | null;

/** Wait for a freshly-mounted iframe to have a contentWindow we can post from. */
const awaitIframeMount = () => pollFor('iframe mount', () => !!iframeEl()?.contentWindow);

async function driveToReady() {
  await awaitIframeMount();
  await pollFor('BLOCK_READY ack', () => {
    postFromBlock('BLOCK_READY', {});
    return iframeEl()?.getAttribute('data-block-ready') === 'true';
  });
}

/** Reach the `fatal` terminal fast (message-driven, no 10s/15s timer window). */
async function driveToFatal() {
  await driveToReady();
  postFromBlock('BLOCK_ERROR', { fatal: true });
  await pollFor('terminal fallback', () => fallbackEl() !== null);
  // Let the scheduling effect arm its backoff timer before anyone measures from
  // "now" — otherwise a boundary assertion would be off by the commit.
  await advance(0);
}

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
    renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={vi.fn()} />
    );
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
    // `fatal` is a NON-auth terminal, so the full attempt budget is reachable.
    expect(line?.textContent).toContain(`attempt 1 of ${MAX_AUTO_RETRIES}`);
    // … and the manual affordance stays available the whole time.
    expect(retryButton()).not.toBeNull();
    // FRAME-1: provenance chrome still wraps it.
    await expect.element(page.getByTestId('app-block-chrome')).toBeInTheDocument();
  });

  test('the automatic attempt actually re-runs the load after the backoff (and says so)', async () => {
    useVirtualClock();
    renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={vi.fn()} />
    );
    await driveToFatal();

    // 🔴 A VIRTUAL clock lets this pin the backoff at its BOUNDARY, which the old
    // real-time version could not: one millisecond-ish before the window elapses
    // the host is still terminal and has NOT re-attempted (a 0ms "backoff" would
    // be a hot loop against a down host)…
    await advance(FIRST_BACKOFF_MS - 50);
    expect(fallbackEl()).not.toBeNull();
    expect(loadingEl()).toBeNull();

    // …and just past it the host re-attempts ON ITS OWN: back to the loading
    // surface, with a fresh iframe, and copy that says a RETRY is under way rather
    // than the identical "Starting …" (the "did the button do anything?" half of
    // the report). Deliberately no attempt NUMBER here — the bounded count lives
    // on the terminal card, so the two surfaces can't show disagreeing counters.
    await advance(100);
    await pollFor('retry loading surface', () => loadingEl() !== null);
    expect(page.getByText('Retrying Budgeted Generator…').query()).not.toBeNull();
    expect(iframeEl()?.getAttribute('data-block-ready')).toBe('false');
  });

  test('auto-retry also fires from the `timeout` terminal (block never acks BLOCK_READY)', async () => {
    useVirtualClock();
    renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={vi.fn()} />
    );
    // The readiness window is armed once the frame mounts; nothing acks, so
    // burning it lands on 'timeout'.
    await awaitIframeMount();
    expect(fallbackEl()).toBeNull();
    await advance(BLOCK_READY_TIMEOUT_MS);
    await pollFor('timeout terminal', () => fallbackEl() !== null);
    // Assert the line EXISTS before reading it — otherwise a host that stopped
    // auto-retrying from `timeout` fails on `.toContain(undefined)`, whose message
    // describes the assertion rather than the regression.
    expect(autoRetryLine()).not.toBeNull();
    expect(autoRetryLine()?.textContent).toContain(`attempt 1 of ${MAX_AUTO_RETRIES}`);
  });

  test('auto-retry also fires from the `no_token` terminal, and it RE-MINTS', async () => {
    useVirtualClock();
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
    // The token-wait window is still open — no terminal yet.
    await advance(TOKEN_WAIT_TIMEOUT_MS - 100);
    expect(fallbackEl()).toBeNull();
    // …and burning the rest of it lands on 'no_token'.
    await advance(200);
    await pollFor('no_token terminal', () => fallbackEl() !== null);
    expect(onRetryToken).not.toHaveBeenCalled();

    // An auth terminal can ONLY be recovered by re-minting (the token is an
    // upstream prop) — so the automatic attempt must re-mint, not just remount.
    await advance(FIRST_BACKOFF_MS + 100);
    await pollFor('re-mint', () => onRetryToken.mock.calls.length >= 1);
    expect(onRetryToken).toHaveBeenCalledTimes(1);
  });

  test('a NON-auth terminal auto-retries WITHOUT re-minting (the token was fine)', async () => {
    useVirtualClock();
    const onRetryToken = vi.fn();
    renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={onRetryToken} />
    );
    await driveToFatal();
    await advance(FIRST_BACKOFF_MS + 100);
    // The automatic attempt DID run — this is the assertion that keeps the test
    // from passing vacuously once it no longer waits in real time.
    await pollFor('retry loading surface', () => loadingEl() !== null);
    // The block crashed; the token was never the problem. Re-minting here would
    // burn the rate-limited endpoint for nothing.
    expect(onRetryToken).not.toHaveBeenCalled();
  });
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
    useVirtualClock();
    const onRemint = vi.fn();
    let renderCount = 0;
    function ChurningParent() {
      const [, setTick] = useState(0);
      renderCount++;
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

    await pollFor('auth terminal with pending retry', () => autoRetryLine() !== null);
    const rendersBefore = renderCount;
    // The attempt must still land despite the re-renders during the backoff. The
    // 100ms interval is on the same virtual clock, so advancing the backoff also
    // churns the parent ~20 times — the churn is the condition under test, so it
    // is asserted, not assumed.
    await advance(FIRST_BACKOFF_MS + 100);
    expect(renderCount - rendersBefore).toBeGreaterThanOrEqual(15);
    await pollFor('re-mint despite churn', () => onRemint.mock.calls.length > 0);
    expect(onRemint).toHaveBeenCalled();
  });
});

describe('PageBlockHost auto-retry — the caps (unbounded loops are the failure mode)', () => {
  test('AUTH terminals re-mint AT MOST MAX_AUTO_REMINTS times, then stop', async () => {
    useVirtualClock();
    const onRemint = vi.fn();
    renderWithProviders(<AuthFailureHarness onRemint={onRemint} />);

    // 🔴 The advertised ceiling on the AUTH path is the RE-MINT budget, not the
    // attempt cap — the user must not be promised a retry that can never happen.
    await pollFor('auth terminal with pending retry', () => autoRetryLine() !== null);
    expect(autoRetryLine()?.textContent).toContain(`attempt 1 of ${MAX_AUTO_REMINTS}`);
    expect(autoRetryLine()?.textContent).not.toContain(`of ${MAX_AUTO_RETRIES}`);

    // The host burns its automatic budget …
    await advance(FIRST_BACKOFF_MS + 100);
    await pollFor('budget spent', () => onRemint.mock.calls.length >= MAX_AUTO_REMINTS);
    expect(onRemint).toHaveBeenCalledTimes(MAX_AUTO_REMINTS);

    // 🔴 …and then STOPS. Advancing well past another full backoff must produce
    // no further re-mint. This is the rate-limit guard: `/api/v1/block-tokens` is
    // 60/min, and an unbounded auth-failure loop is exactly the shape that
    // would burn it. On the virtual clock this now covers MANY multiples of the
    // longest backoff instead of one, for no wall-clock cost at all.
    await advance(10 * LAST_BACKOFF_MS);
    expect(onRemint).toHaveBeenCalledTimes(MAX_AUTO_REMINTS);
  });

  test('after exhaustion the host settles on a DEFINITIVE terminal state with a PROMINENT manual Retry', async () => {
    useVirtualClock();
    const onRemint = vi.fn();
    renderWithProviders(<AuthFailureHarness onRemint={onRemint} />);
    await pollFor('auth terminal with pending retry', () => autoRetryLine() !== null);
    await advance(FIRST_BACKOFF_MS + 100);
    await pollFor('budget spent', () => onRemint.mock.calls.length >= MAX_AUTO_REMINTS);

    // Settle: the pending-retry line is gone and the fallback is final.
    await advance(LAST_BACKOFF_MS + 1_000);
    await pollFor('settled terminal', () => fallbackEl() !== null && autoRetryLine() === null);

    // 🔴 THE ACTUAL REPORTED FAILURE: the manual affordance must now be
    // impossible to miss. It is filled + full-width rather than the small
    // subdued default, and the host says plainly that it already tried.
    const btn = retryButton();
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('data-block-fallback-retry-prominent')).toBe('true');
    // …and it states honestly how many automatic attempts were actually spent
    // (asserted off the rendered count, not a hardcoded cap — the auth path stops
    // at the RE-MINT cap, which is strictly below the attempt cap).
    const spentNote = document.querySelector('[data-block-fallback-autoretry-spent]');
    expect(spentNote).not.toBeNull();
    expect(spentNote?.getAttribute('data-block-fallback-autoretry-spent')).toBe(
      String(MAX_AUTO_REMINTS)
    );
    expect(spentNote?.textContent).toMatch(/already retried/);
    // Still reachable by its stable accessible name, and still inside the chrome.
    expect(page.getByRole('button', { name: 'Retry' }).query()).not.toBeNull();
    expect(page.getByTestId('app-block-chrome').query()).not.toBeNull();
  });
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

  test('success on attempt 2 emits EXACTLY ONE `ok` beacon — and no `error` first', async () => {
    useVirtualClock();
    renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={vi.fn()} />
    );

    // Attempt 1 fails by never acking → 'timeout'. It must emit NOTHING (an
    // automatic attempt is still coming — the host has not settled).
    await awaitIframeMount();
    await advance(BLOCK_READY_TIMEOUT_MS);
    await pollFor('timeout terminal', () => fallbackEl() !== null);
    expect(beaconCalls()).toHaveLength(0);

    // Attempt 2 runs (a fresh loading surface) and succeeds.
    await advance(FIRST_BACKOFF_MS + 100);
    await pollFor('retry loading surface', () => loadingEl() !== null);
    await driveToReady();

    await pollFor('ok beacon', () => beaconCalls().length >= 1);
    const [body] = beaconBodies();
    // The `ok` beacon carries no `status` field (see sendBlockRender).
    expect(body).toEqual({
      appBlockId: 'apb_test',
      blockInstanceId: 'page_apb_test',
      slotId: 'app.page',
    });
    // Give any stray emit a chance to show up before asserting exclusivity — on
    // the virtual clock that can be a generous window for free.
    await advance(LAST_BACKOFF_MS + BLOCK_READY_TIMEOUT_MS);
    expect(beaconCalls()).toHaveLength(1);
  });

  test('a mount that already reported `ok` never additionally reports `error` after a crash + failed recovery', async () => {
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
    useVirtualClock();
    renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={vi.fn()} />
    );

    // Load succeeds → exactly one `ok`.
    await driveToReady();
    await pollFor('ok beacon', () => beaconCalls().length >= 1);
    expect(beaconBodies()[0]).not.toHaveProperty('status');

    // Then the block crashes and every automatic recovery attempt fails (the
    // fresh frames never ack, so each rides the readiness timeout). Stepped
    // explicitly rather than in one big jump, so the test asserts that each
    // automatic attempt REALLY RAN — a fresh loading surface with a fresh frame —
    // instead of only that the end state looks settled.
    postFromBlock('BLOCK_ERROR', { fatal: true });
    await pollFor('fatal terminal', () => fallbackEl() !== null);
    await advance(0);
    for (const backoffMs of AUTO_RETRY_BACKOFF_MS.slice(0, MAX_AUTO_RETRIES)) {
      await advance(backoffMs + 100);
      await pollFor('automatic attempt runs', () => loadingEl() !== null);
      await awaitIframeMount();
      await advance(BLOCK_READY_TIMEOUT_MS);
      await pollFor('attempt times out', () => fallbackEl() !== null);
    }
    expect(autoRetryLine()).toBeNull(); // settled: budget spent

    // Still exactly the one `ok` — no `error` beacon was re-opened.
    expect(beaconCalls()).toHaveLength(1);
    expect(beaconBodies()[0]).not.toHaveProperty('status');

    // This is the only path that exhausts the FULL attempt budget (a non-auth
    // terminal is not bound by the lower re-mint cap), so it is where the PLURAL
    // exhausted-copy branch is reachable — pin it here or it has no coverage
    // anywhere.
    const spentNote = document.querySelector('[data-block-fallback-autoretry-spent]');
    expect(spentNote?.getAttribute('data-block-fallback-autoretry-spent')).toBe(
      String(MAX_AUTO_RETRIES)
    );
    expect(spentNote?.textContent).toBe(
      `We already retried ${MAX_AUTO_RETRIES} times automatically.`
    );
  });

  test('N failed automatic attempts emit ONE `error` beacon, not N', async () => {
    useVirtualClock();
    const onRemint = vi.fn();
    renderWithProviders(<AuthFailureHarness onRemint={onRemint} />);

    // Burn the whole automatic budget — and assert it was actually burnt, so the
    // "one beacon" claim below is about a real multi-attempt sequence.
    await pollFor('auth terminal with pending retry', () => autoRetryLine() !== null);
    await advance(FIRST_BACKOFF_MS + 100);
    await pollFor('budget spent', () => onRemint.mock.calls.length >= MAX_AUTO_REMINTS);

    // Settle, then exactly ONE error beacon for the whole sequence.
    await advance(LAST_BACKOFF_MS + 1_000);
    await pollFor('error beacon', () => beaconCalls().length >= 1);
    const [body] = beaconBodies();
    expect(body.status).toBe('error');
    // errorClass stays inside the server-side KNOWN_ERROR_CLASSES enum, so the
    // existing prom label + its alert are unchanged by auto-retry.
    expect(['error', 'no_token']).toContain(body.errorClass);

    await advance(10 * LAST_BACKOFF_MS);
    expect(beaconCalls()).toHaveLength(1);
  });
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
  // 🔴 REAL TIMERS ON PURPOSE. This is the only case driven by a real Playwright
  // `.click()`, and the driver's own round-trip must not race a faked clock. It
  // never waits out a recovery window (it deliberately takes over mid-backoff),
  // so it costs ~0.4s as-is and has nothing to gain from a virtual clock.
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

  test('unmounting mid-backoff leaks NO timer — the pending attempt never fires', async () => {
    useVirtualClock();
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
    await pollFor('auth terminal with pending retry', () => autoRetryLine() !== null);

    // 🔴 On the virtual clock the backoff DEMONSTRABLY has not elapsed yet — the
    // real-time version could only hope so, and had to snapshot a possibly-nonzero
    // count to stay honest. Here the pending attempt is provably still pending, so
    // the assertion below is "zero, and still zero", not "unchanged from whatever".
    expect(onRemint).not.toHaveBeenCalled();

    // … unmount before the backoff elapses. A native click (not a driver click)
    // because the clock is virtual; the handler under test is React's onClick.
    (page.getByTestId('unmount-host').element() as HTMLButtonElement).click();
    await pollFor('host unmounted', () => page.getByTestId('app-page-frame').query() === null);

    // 🔴 A leaked timer would fire the scheduled attempt after unmount — hitting
    // the rate-limited mint endpoint for a page nobody is looking at. Advance well
    // past the backoff and assert nothing fired.
    await advance(10 * LAST_BACKOFF_MS);
    expect(onRemint).not.toHaveBeenCalled();
  });
});
