import { useState } from 'react';
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only (erased at runtime, so it can't defeat vi.mock hoisting) — lets the
// `importOriginal` generic below be written without an inline `import()` type,
// which the repo's `consistent-type-imports` rule forbids (this file was the
// last lint error in src/components/AppBlocks).
import type * as MantineNotifications from '@mantine/notifications';

// PageBlockHost wires the money-path workflow bridge AND the storage bridge,
// which call `trpc.blocks.*.useMutation()`, `trpc.apps.storage.*.useMutation()`,
// and `trpc.useUtils()` at render — that needs the tRPC Context (the `withTRPC`
// HoC) the network-free component scaffold doesn't provide. Mock the tRPC client
// so these consent-focused tests stay network-free and mount the component
// without a real tRPC provider. The workflow + storage bridges are exercised in
// PageBlockHostWorkflow / PageBlockHostStorage.browser.test.tsx; here they're
// inert stubs.
// AppBlockChrome (in the host frame) calls useCurrentUser() for the platform-nav
// moderator gate; these suites render the real host without a CivitaiSessionProvider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// Issue B: spy on the toast so the un-grantable-consent path is assertable without
// mounting the full Notifications provider. Preserve the module's other exports.
const showNotificationSpy = vi.fn();
vi.mock('@mantine/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof MantineNotifications>();
  return { ...actual, showNotification: (args: unknown) => showNotificationSpy(args) };
});

vi.mock('~/utils/trpc', () => ({
  // FeatureFlagsProvider (pulled into PageBlockHost's real render graph) statically
  // imports `setTrpcBatchingEnabled` from this module (added in #2946). Because
  // `vi.mock` replaces the module wholesale, the factory MUST re-declare that named
  // export or the ESM link fails ("does not provide an export named …") and the whole
  // test file fails to import — silently, since this suite is report-only.
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    // Collection follow/unfollow host bridge (SET_COLLECTION_FOLLOW). Both
    // hosts register the handler, so every host-rendering suite needs these
    // two session-authed mutations present on the mocked client.
    collection: {
      follow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      unfollow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    // W13 wildcard-pack import: PageBlockHost now calls this at render; stub so the mount succeeds (behavior covered in PageBlockHostWildcardPack.browser.test.tsx).
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
// eslint-disable-next-line import/first
import { IframeInitController } from '~/components/AppBlocks/iframeInitController';

/**
 * W10 lazy-consent gap regression (page surface).
 *
 * A full-page App Block (`/apps/run/<slug>`) that needs a consent-gated scope
 * (e.g. `ai:write:budgeted` once #2612 enabled the page money scope) fires
 * REQUEST_CONSENT on the user's first Generate. Before this fix the consent
 * bridge was only wired into the model-slot host (IframeHost); the page host
 * (PageBlockHost) never handled REQUEST_CONSENT, so the message fired into the
 * void and the block hung on "confirm in the Civitai dialog".
 *
 * These tests mount the REAL PageBlockHost (mirroring AppBlockChrome.browser.test
 * / the model path's testing posture) and drive the actual postMessage bridge:
 *   - iframeSrc is same-origin + trustTier='internal' so the transport runs in
 *     PINNED mode (allow-same-origin → real origin === expectedOrigin), exactly
 *     like a verified/internal block. We post FROM the iframe's contentWindow so
 *     the `event.source === iframe.contentWindow` authenticating pin holds.
 *   - We assert against the shared dialogStore (the same store IframeHost's
 *     consent handler triggers) rather than rendering the modal, since
 *     BlockConsentModal needs a real tRPC mutation. This pins the host→dialog
 *     wiring: gate result → BlockConsentModal with the server-known missing set,
 *     appName as blockName, and onGranted → onConsentGranted.
 *
 * The pure gate (readiness + non-empty + server-known set) is covered by
 * requestConsentGate.test.ts; this is the host-integration layer.
 */

// Simulate a message FROM the host iframe by dispatching a MessageEvent whose
// `source` is the iframe's contentWindow and whose `origin` matches the host's
// expectedOrigin (same-origin iframeSrc). This satisfies BOTH authenticating
// pins usePostMessage enforces on real block messages —
//   1. event.source === iframe.contentWindow (the spoof guard), and
//   2. isInboundOriginAccepted(origin, expectedOrigin) (the origin pin) —
// without depending on a real cross-document load racing the test (a live
// contentWindow.postMessage to a still-loading same-origin frame is dropped).
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

/**
 * Capture host→block posts. `send` targets the iframe's contentWindow, so the
 * assertable record of what the HOST told the BLOCK is a listener on that
 * window (same helper shape as PageBlockHostThemeChange / -Storage).
 *
 * Attach it AFTER the iframe is in the DOM (i.e. after `driveToReady`); it is
 * structurally blind to anything posted before it subscribes, which is fine for
 * the consent path — every message under test is a response to a REQUEST_CONSENT
 * the test itself posts later.
 */
function listenForHostPosts() {
  const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
  const cw = el.contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const received: Array<{ type: string; payload: unknown }> = [];
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  };
  cw.addEventListener('message', handler);
  return {
    received,
    of: (type: string) => received.filter((m) => m.type === type),
    clear: () => received.splice(0, received.length),
    stop: () => cw.removeEventListener('message', handler),
  };
}

/**
 * Record the ORDER of the two host-side effects on the un-grantable branch: the
 * CONSENT_UNAVAILABLE bridge push and the host toast.
 *
 * `listenForHostPosts` above structurally CANNOT do this. `send` →
 * `contentWindow.postMessage` is delivered asynchronously, so its listener always
 * runs after the whole handler has returned — a `vi.fn()` toast spy that cannot
 * throw plus an async delivery means moving `send` below `showNotification` in the
 * product changes nothing any of those assertions can see.
 *
 * The CALL to `postMessage` is synchronous, so patching it on the target window
 * records the two markers in the order the handler actually performs them. Only
 * CONSENT_UNAVAILABLE is recorded — the host also posts BLOCK_INIT/TOKEN_REFRESH
 * through the same window.
 */
function recordConsentEffectOrder() {
  const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
  const cw = el.contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const order: string[] = [];
  const original = cw.postMessage.bind(cw) as (message: unknown, targetOrigin: string) => void;
  cw.postMessage = ((message: unknown, targetOrigin: string) => {
    const type = (message as { type?: string } | null)?.type;
    if (type === 'CONSENT_UNAVAILABLE') order.push('send');
    original(message, targetOrigin);
  }) as unknown as Window['postMessage'];
  showNotificationSpy.mockImplementation(() => {
    order.push('toast');
  });
  return {
    order,
    stop: () => {
      cw.postMessage = original as unknown as Window['postMessage'];
      // mockClear() (the beforeEach) keeps implementations — reset so the marker
      // impl cannot leak into another test.
      showNotificationSpy.mockReset();
    },
  };
}

// Same-origin so trustTier='internal' yields a pinned (non-opaque) transport
// whose expectedOrigin equals this frame's origin.
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
  // Required. These suites cover the DEFAULT (host-veil) presentation;
  // the bootSkeleton path is covered in PageBlockHostLaunchReveal.
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'my-page-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: ['apps:storage:read', 'apps:storage:write', 'ai:write:budgeted'],
  missingScopes: ['ai:write:budgeted'],
  needsConsent: true,
  tokenError: false,
  viewer: { id: 42, username: 'tester' },
  theme: 'light' as const,
};

/**
 * Tests below exercise PageBlockHost's REAL recovery windows —
 * `BLOCK_READY_TIMEOUT_MS` (10s) and `TOKEN_WAIT_TIMEOUT_MS` (15s) in PageBlockHost.tsx,
 * plus the bounded auto-retry's first backoff (`AUTO_RETRY_BACKOFF_MS[0]`, 2s) in
 * pageBlockHostLogic.ts. Sleeping through them in real time cost ~76s, ~95% of this
 * file's runtime.
 *
 * There are TWO clock helpers here and the difference between them is the ONLY thing
 * that matters when reading these tests: whether the test touches the DOM while the
 * clock is installed.
 *
 *   useFakeClock() + advancePastWindow(ms) — for a test that merely WAITS OUT a window
 *     and then asserts. `advancePastWindow` deliberately hands control back to REAL
 *     timers on the way out, so everything after it — assertions, `vi.waitFor`, locator
 *     queries — runs on the normal clock. `shouldAdvanceTime` keeps the fake clock
 *     ticking with real time while it is installed so locator polling still progresses.
 *     🔴 Do NOT use this pair around a user gesture: the real clock it restores is
 *     exactly the clock a gesture would be racing. See useVirtualClock.
 *
 *   useVirtualClock() + advance(ms) / pollFor(...) — for a test that CLICKS. The
 *     virtual clock STAYS INSTALLED across the click, which is the whole point.
 *
 * Neither weakens a test: each still asserts the same terminal DOM state, and the
 * elapsed window is stated outright — `advancePastWindow(11_000)` for a 10s window, or
 * `advance(BLOCK_READY_TIMEOUT_MS)` plus `pollFor` nudges — rather than being implied by
 * a generous real-time poll. The `afterEach` below is a safety net so a mid-test failure
 * can never leak a fake clock into the next test.
 */
function useFakeClock() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
}
async function advancePastWindow(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  vi.useRealTimers();
}

/**
 * Install the VIRTUAL clock for one test. Call it BEFORE `renderWithProviders`, so the
 * host's effects arm their timers against it (installing it afterwards does nothing —
 * the timers are already on the real clock).
 *
 * 🔴 THIS IS THE CLOCK FOR A TEST THAT CLICKS, AND IT MUST STAY INSTALLED ACROSS THE
 * CLICK. The four Retry tests below drive the button through the browser driver and
 * then assert on `onRetryToken` call counts. Their premise is that the host's BOUNDED
 * AUTO-RETRY has not yet fired when the user takes over — and an automatic attempt from
 * an auth terminal RE-MINTS, i.e. it moves the very counter under assertion. On the real
 * clock that premise is a race against `AUTO_RETRY_BACKOFF_MS[0]` (2000ms) which the
 * driver's round-trip can lose on a loaded machine.
 *
 * `toFake` is restricted to the timer functions on purpose. Leaving `Date`,
 * `performance` and `requestAnimationFrame` REAL keeps React's scheduler, Mantine and
 * the Playwright driver behaving exactly as they do under real timers — the driver still
 * spends REAL time, which is not the clock these tests race. Virtual time between arming
 * the backoff and the click advances by ~0ms, so the premise becomes PROVABLE rather
 * than probable.
 *
 * 🔴 Installing a fake clock is NOT by itself sufficient, and that is the trap that
 * makes this worth spelling out: two of those four tests already installed one, but
 * reached it through `advancePastWindow`, which restores REAL timers on the way out by
 * design — so the click and every assertion after it ran on the real clock anyway.
 *
 * The same reasoning, and the CI flake (civitai#3674) that established it, is recorded
 * at length in PageBlockHostAutoRetry.browser.test.tsx; these were the last four sites
 * of that class still on the real clock.
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
 * The REAL `setTimeout`, captured at module load — before any test installs a fake
 * clock, so this binding is never the faked one. `pollFor` needs it: a poll that only
 * advances VIRTUAL time hands the browser almost no real time, so anything genuinely
 * asynchronous (an iframe mounting) can miss its window on a loaded box while the poll
 * burns its whole budget in milliseconds.
 */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realSleep = (ms: number) => new Promise((r) => realSetTimeout(r, ms));

/**
 * Move time forward by `ms` and let React commit. Works under EITHER clock, so the
 * helpers below are shared by the virtual-clock tests and the real-timer ones. Under the
 * virtual clock the elapsed time is EXACT, which is what makes a window jump
 * deterministic instead of a race against the runner.
 */
async function advance(ms: number) {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(ms);
    // Flush the promise/effect chain the fired timers kicked off. Each async tick also
    // yields a REAL macrotask, so the browser (iframe loads, React's scheduler) makes
    // progress even while virtual time stands still.
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
    return;
  }
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll `ready()`, nudging the clock in small steps.
 *
 * 🔴 For things that depend on real browser work — an iframe mounting, a React commit
 * landing. NEVER to wait out one of the host's recovery windows: those are jumped with
 * an explicit `advance(WINDOW)` so a test states exactly how much time it believes has
 * passed.
 *
 * Two budgets, deliberately decoupled: at most 500ms of VIRTUAL time (well inside the
 * shortest recovery window, the 2s backoff, so a poll can never silently trip the very
 * behaviour a test is about to assert) and a bounded slice of REAL time for the browser to
 * actually do the work. Advancing virtual time alone would give the page only
 * microtasks — the failure mode that makes a fake-timer poll report "iframe never
 * mounted" on a saturated runner.
 *
 * This is also why the clicking tests below use `pollFor` instead of `vi.waitFor`:
 * `vi.waitFor` ADVANCES the fake clock while polling, spending virtual time against the
 * very backoff the test needs to stay pending.
 */
/**
 * 🔴 THE ITERATION COUNT IS SIZED AGAINST TWO CEILINGS, NOT PICKED.
 *
 * Each fake-clock iteration costs ~30ms REAL (the flush loop's macrotasks plus the
 * 10ms sleep) and 1ms VIRTUAL. So the budget is ~4.5s real / 150ms virtual.
 *
 * REAL ceiling: browser mode forces `testTimeout` to 15s and the root config's 60s
 * does NOT reach the `component` project. At 500 iterations this loop ran ~15s and
 * LOST THE RACE to that timeout — measured: the tests below without an explicit
 * timeout died as `Test timed out in 15000ms` instead of naming what they waited
 * for, and the one with `20_000` cleared it by 93ms. Staying well under 15s is what
 * keeps a failure legible.
 *
 * VIRTUAL ceiling: every millisecond spent here is spent against
 * `AUTO_RETRY_BACKOFF_MS[0]` (2000ms), which these tests need to stay PENDING.
 * 150ms is ~13x inside it. Measured actual spend between terminal and click is
 * 1-10ms, so this is headroom, not a working budget.
 */
async function pollFor(what: string, ready: () => boolean) {
  const fake = vi.isFakeTimers();
  for (let i = 0; i < 150; i++) {
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

const iframeElQuery = () => page.getByTestId('app-page-iframe').query() as HTMLIFrameElement | null;
const loadingElQuery = () => page.getByTestId('app-page-loading').query();
const fallbackElQuery = () => page.getByTestId('app-page-fallback').query();

// Drive the handshake to BLOCK_READY (status='ready') so the consent gate's
// `status === 'ready'` precondition is satisfied — same prerequisite a real
// block hits before its first Generate.
//
// Built on `pollFor` rather than `vi.waitFor` so it is clock-agnostic: the four Retry
// tests below call it under the virtual clock, where `vi.waitFor` would spend virtual
// time against a pending backoff.
async function driveToReady() {
  // Wait until the iframe is mounted + its contentWindow is reachable.
  await pollFor('iframe mount', () => !!iframeElQuery()?.contentWindow);
  // The host posts BLOCK_INIT on a retry interval; we just ack READY.
  await pollFor('BLOCK_READY ack', () => {
    postFromBlock('BLOCK_READY', {});
    return iframeElQuery()?.getAttribute('data-block-ready') === 'true';
  });
}

describe('PageBlockHost REQUEST_CONSENT (W10 lazy-consent wiring)', () => {
  beforeEach(() => {
    // dialogStore is a module-level zustand store shared across tests — reset it.
    useDialogStore.getState().closeAll();
    showNotificationSpy.mockClear();
  });

  test('after BLOCK_READY, REQUEST_CONSENT opens the consent dialog with the server-known missing set', async () => {
    const onConsentGranted = vi.fn();
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={onConsentGranted} />);

    await driveToReady();
    expect(useDialogStore.getState().dialogs).toHaveLength(0);

    // The block claims a WIDER set than the host withheld — the host must ignore
    // the claim and grant only its server-known missingScopes.
    //
    // Posted inside the waitFor purely so the assertion retries if the DIALOG has
    // not rendered yet. The gate itself no longer lags: the host reads a
    // render-body-updated `statusRef`, so once `data-block-ready` is "true" the
    // handler is live. (This used to say the message-gate state could lag the DOM
    // attribute by a tick and a dropped fire-and-forget post was never retried —
    // true before the stale-closure fix, false now.) waitFor exits on the first
    // success, so exactly one post opens exactly one dialog.
    await vi.waitFor(() => {
      postFromBlock('REQUEST_CONSENT', { scopes: ['ai:write:budgeted', 'buzz:spend:self'] });
      expect(useDialogStore.getState().dialogs).toHaveLength(1);
    });

    const dialog = useDialogStore.getState().dialogs[0];
    const dialogProps = dialog.props as {
      appBlockId: string;
      blockName?: string;
      missingScopes: string[];
      onGranted: () => void;
    };
    // Grant ONLY the server-known missing set, never the block's wider claim.
    expect(dialogProps.missingScopes).toEqual(['ai:write:budgeted']);
    expect(dialogProps.appBlockId).toBe('apb_test');
    // PageBlockHost surfaces the app name as `appName` → BlockConsentModal.blockName.
    expect(dialogProps.blockName).toBe('Budgeted Generator');

    // onGranted → onConsentGranted (re-mint hook) — the fire-and-forget channel
    // that re-mints the token; the rotated token's TOKEN_REFRESH delivers scopes.
    expect(onConsentGranted).not.toHaveBeenCalled();
    dialogProps.onGranted();
    expect(onConsentGranted).toHaveBeenCalledTimes(1);
  });

  test('REQUEST_CONSENT before BLOCK_READY is dropped (no pre-handshake permission modal)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);

    // Do NOT drive to ready — fire consent while status is still 'loading'.
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
      if (!el.contentWindow) throw new Error('not mounted yet');
    });
    postFromBlock('REQUEST_CONSENT', { scopes: ['ai:write:budgeted'] });

    // Give the message a chance to be (incorrectly) handled, then assert it wasn't.
    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
  });

  test('REQUEST_CONSENT with nothing missing is a no-op (no dialog)', async () => {
    renderWithProviders(
      <PageBlockHost
        {...baseProps}
        missingScopes={[]}
        needsConsent={false}
        onConsentGranted={vi.fn()}
      />
    );

    await driveToReady();

    // 🔴 POSITIVE CONTROL, and it is not optional. Everything this test asserts is a
    // ZERO — no dialog, no toast — and a host that simply DROPPED the message
    // produces that same zero. Before the stale-closure fix that was a live
    // possibility: the handler closed over `status` and stayed non-ready until a
    // passive effect re-registered it, so this test could pass without ever
    // exercising its own subject ("nothing missing is a no-op").
    //
    // `models:read:self` is neither granted (not in declaredScopes) nor grantable
    // (missingScopes is empty), so it is UN-GRANTABLE and must surface a toast —
    // proving the handler is live under exactly these props before the zero is read.
    postFromBlock('REQUEST_CONSENT', { scopes: ['models:read:self'] });
    await vi.waitFor(() => expect(showNotificationSpy).toHaveBeenCalledTimes(1));
    showNotificationSpy.mockClear();

    // THE SUBJECT: baseProps.declaredScopes already carries ai:write:budgeted, so
    // with nothing missing it is ALREADY granted → benign re-request → no dialog AND
    // no toast. This zero is now a measurement, because the control above proved a
    // non-zero is reachable on this very mount.
    postFromBlock('REQUEST_CONSENT', { scopes: ['ai:write:budgeted'] });

    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(showNotificationSpy).not.toHaveBeenCalled();
  });

  test('Issue B: an UN-GRANTABLE requested scope (clamped at mint) surfaces a toast, not a silent drop', async () => {
    // The preview token carries no storage scopes and nothing is grantable via
    // consent (missingScopes empty) — a block asking for apps:storage:write can
    // NEVER be satisfied here. Instead of dropping silently (dead-looking button),
    // the host surfaces a user-visible message.
    renderWithProviders(
      <PageBlockHost
        {...baseProps}
        declaredScopes={['models:read:self']}
        missingScopes={[]}
        needsConsent={false}
        onConsentGranted={vi.fn()}
      />
    );

    await driveToReady();
    await vi.waitFor(() => {
      postFromBlock('REQUEST_CONSENT', { scopes: ['apps:storage:write'] });
      expect(showNotificationSpy).toHaveBeenCalledTimes(1);
    });
    // No consent dialog is opened for an un-grantable scope.
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
  });

  /**
   * The refusal must be observable to the BLOCK, not only to the viewer.
   *
   * The host-side toast renders in the HOST frame. Nothing was posted back over
   * the bridge, so the block could not tell "the user hasn't confirmed the dialog
   * yet" from "this environment will never grant this scope" — and its own UI kept
   * telling the developer to retry an action that can never succeed, directly
   * contradicting the corner toast on the same screen.
   */
  test('Issue B: an UN-GRANTABLE REQUEST_CONSENT posts CONSENT_UNAVAILABLE to the block with the refused scopes', async () => {
    renderWithProviders(
      <PageBlockHost
        {...baseProps}
        declaredScopes={['models:read:self']}
        missingScopes={[]}
        needsConsent={false}
        onConsentGranted={vi.fn()}
      />
    );

    await driveToReady();
    const posts = listenForHostPosts();
    try {
      // Post exactly ONCE, outside the waitFor. `send` → `contentWindow.postMessage`
      // is delivered asynchronously, so a post INSIDE a retrying waitFor fires
      // several REQUEST_CONSENTs before the first CONSENT_UNAVAILABLE lands and the
      // extra replies arrive later — which makes the count untrustworthy here and
      // actively broke the benign test's zero below. `driveToReady` already proved
      // the handler is live (it reads a render-body ref, not a stale closure), so
      // one post is enough; the waitFor only awaits DELIVERY.
      postFromBlock('REQUEST_CONSENT', { scopes: ['apps:storage:write', 'apps:storage:read'] });
      await vi.waitFor(() => expect(posts.of('CONSENT_UNAVAILABLE')).toHaveLength(1));

      const msg = posts.of('CONSENT_UNAVAILABLE')[0];
      expect(msg.payload).toEqual({
        reason: 'ungrantable',
        // The host's own computed un-grantable set (sorted+deduped), filtered to
        // the known block-scope vocabulary — not the block's raw hint echoed back.
        scopes: ['apps:storage:read', 'apps:storage:write'],
      });

      // ADDITIVE, not a replacement: the viewer-facing toast still fires, and the
      // un-grantable path still opens no consent dialog.
      expect(showNotificationSpy).toHaveBeenCalled();
      expect(useDialogStore.getState().dialogs).toHaveLength(0);
    } finally {
      posts.stop();
    }
  });

  /**
   * 🔴 The payload is UNTRUSTED BLOCK INPUT until the host filters it.
   *
   * `payload.scopes` on a REQUEST_CONSENT is whatever the block's own frame put
   * there, and the CONSENT_UNAVAILABLE push hands it to block UI to render. The
   * host therefore names only scopes from the fixed platform vocabulary.
   *
   * The decision to refuse is NOT filtered, and that half is the more important
   * one: the un-grantable set is the trigger as well as the payload, so filtering
   * the trigger would make a request for an un-grantable scope the vocabulary
   * doesn't know produce no message and no toast — silently deleting the existing
   * user-visible behaviour in the name of sanitising it.
   */
  test('Issue B: unknown/garbage/oversized scopes are DROPPED from the CONSENT_UNAVAILABLE payload, and the message + toast still fire', async () => {
    renderWithProviders(
      <PageBlockHost
        {...baseProps}
        declaredScopes={['models:read:self']}
        missingScopes={[]}
        needsConsent={false}
        onConsentGranted={vi.fn()}
      />
    );

    await driveToReady();
    const posts = listenForHostPosts();
    try {
      // Every requested scope is un-grantable AND outside the vocabulary.
      postFromBlock('REQUEST_CONSENT', {
        scopes: ['<img src=x onerror=alert(1)>', 'not:a:real:scope', 'A'.repeat(5000)],
      });
      await vi.waitFor(() => expect(posts.of('CONSENT_UNAVAILABLE')).toHaveLength(1));

      // The refusal is still delivered — with NO names, because none survived.
      expect(posts.of('CONSENT_UNAVAILABLE')[0].payload).toEqual({
        reason: 'ungrantable',
        scopes: [],
      });
      // …and the existing host-side behaviour is byte-for-byte unchanged.
      expect(showNotificationSpy).toHaveBeenCalledTimes(1);
      expect(useDialogStore.getState().dialogs).toHaveLength(0);
    } finally {
      posts.stop();
    }
  });

  test('Issue B: a MIXED hint names only the KNOWN scopes in the payload (sorted order preserved)', async () => {
    renderWithProviders(
      <PageBlockHost
        {...baseProps}
        declaredScopes={['models:read:self']}
        missingScopes={[]}
        needsConsent={false}
        onConsentGranted={vi.fn()}
      />
    );

    await driveToReady();
    const posts = listenForHostPosts();
    try {
      postFromBlock('REQUEST_CONSENT', {
        scopes: ['apps:storage:write', 'not:a:real:scope', 'apps:storage:read'],
      });
      await vi.waitFor(() => expect(posts.of('CONSENT_UNAVAILABLE')).toHaveLength(1));

      expect(posts.of('CONSENT_UNAVAILABLE')[0].payload).toEqual({
        reason: 'ungrantable',
        scopes: ['apps:storage:read', 'apps:storage:write'],
      });
    } finally {
      posts.stop();
    }
  });

  test('Issue B: the CONSENT_UNAVAILABLE push happens BEFORE the toast', async () => {
    renderWithProviders(
      <PageBlockHost
        {...baseProps}
        declaredScopes={['models:read:self']}
        missingScopes={[]}
        needsConsent={false}
        onConsentGranted={vi.fn()}
      />
    );

    await driveToReady();
    const rec = recordConsentEffectOrder();
    try {
      postFromBlock('REQUEST_CONSENT', { scopes: ['apps:storage:write'] });
      await vi.waitFor(() => expect(rec.order).toHaveLength(2));
      // The block's signal must not be reachable only past a notification layer
      // that can throw. Asserted on the synchronous CALLS — see the helper.
      expect(rec.order).toEqual(['send', 'toast']);
    } finally {
      rec.stop();
    }
  });

  test('the BENIGN already-granted REQUEST_CONSENT posts NO CONSENT_UNAVAILABLE (the silent no-op stays silent)', async () => {
    renderWithProviders(
      <PageBlockHost
        {...baseProps}
        missingScopes={[]}
        needsConsent={false}
        onConsentGranted={vi.fn()}
      />
    );

    await driveToReady();
    const posts = listenForHostPosts();
    try {
      // 🔴 POSITIVE CONTROL. The subject of this test is a ZERO, and a host that
      // dropped the message — or a listener wired to nothing — produces the same
      // zero. `models:read:self` is neither granted (absent from declaredScopes)
      // nor grantable (missingScopes is empty), so it is UN-GRANTABLE and MUST
      // produce a CONSENT_UNAVAILABLE on this very mount. Watch the count move
      // before reading the zero. ONE post (see the note in the test above), so the
      // exactly-one assertion also proves nothing is still in flight when we clear.
      postFromBlock('REQUEST_CONSENT', { scopes: ['models:read:self'] });
      await vi.waitFor(() => expect(posts.of('CONSENT_UNAVAILABLE')).toHaveLength(1));
      posts.clear();
      showNotificationSpy.mockClear();

      // THE SUBJECT: `ai:write:budgeted` is in declaredScopes and nothing is
      // withheld, so the block is re-requesting a scope it ALREADY holds. Nothing
      // is blocked ⇒ no toast AND no bridge message. Emitting here would train
      // blocks to render a "permission unavailable" state on a working permission.
      postFromBlock('REQUEST_CONSENT', { scopes: ['ai:write:budgeted'] });
      await new Promise((r) => setTimeout(r, 150));
      expect(posts.of('CONSENT_UNAVAILABLE')).toHaveLength(0);
      expect(showNotificationSpy).not.toHaveBeenCalled();
      expect(useDialogStore.getState().dialogs).toHaveLength(0);
    } finally {
      posts.stop();
    }
  });

  test('reviewMode surfaces a passive reduced-permissions notice and NEVER a consent modal', async () => {
    // Was: reviewMode dropped REQUEST_CONSENT silently, so a moderator clicking a
    // consent-gated action in the review preview got nothing at all and the app
    // parked forever on its consent card. The modal ban is unchanged (untrusted
    // review code must never pop a permission prompt at the mod) — only the
    // silence is fixed. Full coverage lives in
    // PageBlockHostReviewMode.browser.test.tsx.
    renderWithProviders(
      <PageBlockHost
        {...baseProps}
        declaredScopes={['models:read:self']}
        missingScopes={[]}
        needsConsent={false}
        reviewMode
        onConsentGranted={vi.fn()}
      />
    );

    await driveToReady();
    await vi.waitFor(() => {
      postFromBlock('REQUEST_CONSENT', { scopes: ['apps:storage:write'] });
      expect(showNotificationSpy).toHaveBeenCalledTimes(1);
    });
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
  });
});

describe('PageBlockHost loading indicator (Task 1)', () => {
  test('shows a loading indicator before BLOCK_READY and removes it once ready', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);

    // While status === 'loading' (iframe mounted, pre-handshake) the centered
    // launch overlay is present so the surface isn't blank.
    await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();
    await expect.element(page.getByTestId('app-page-loading-skeleton')).toBeInTheDocument();

    // a11y: the overlay container is marked as a busy live region (role="status"
    // + aria-busy) so a screen reader announces the loading state on the REGION.
    // That region is the only announcing element — the skeleton group inside it
    // is aria-hidden. Assert the attributes while still loading.
    const overlay = page.getByTestId('app-page-loading').element();
    expect(overlay.getAttribute('role')).toBe('status');
    expect(overlay.getAttribute('aria-busy')).toBe('true');

    // Drive the handshake to BLOCK_READY → status flips to 'ready'.
    await driveToReady();

    // The overlay is gated purely on status === 'loading', so it unmounts the
    // instant the block is ready — never spins forever.
    await vi.waitFor(() => {
      expect(page.getByTestId('app-page-loading').query()).toBeNull();
    });
  });

  test('the launch copy runs appName through the chrome sanitizer (control/bidi chars stripped)', async () => {
    // A publisher-controlled name carrying a control char (\t) and a bidi
    // override (U+202E) must NOT reach the launch surface verbatim — it goes
    // through the SAME sanitizeAppChromeName the visible chrome uses: the \t
    // control char becomes a space and the U+202E format char is dropped →
    // 'Evil App' (verified against the sanitizer's documented behaviour +
    // appChromeName.test.ts). Built from char codes so the source carries no
    // literal invisible chars.
    //
    // Asserted on the VISIBLE launch copy. This used to read the overlay's
    // aria-label, which was removed when the loading indicator became an
    // aria-hidden skeleton — the sanitizer contract is unchanged and is what
    // this pins, so it moves to the surface that still carries the name rather
    // than being dropped with the attribute.
    const spoofedName = 'Evil' + String.fromCharCode(0x09) + String.fromCharCode(0x202e) + 'App';
    renderWithProviders(
      <PageBlockHost {...baseProps} appName={spoofedName} onConsentGranted={vi.fn()} />
    );
    await expect.element(page.getByText('Starting Evil App…')).toBeInTheDocument();
  });

  test('the error terminal path shows the fallback and never the loader (does not spin forever)', async () => {
    // token=null + tokenError=true → the `error` effect flips status out of
    // 'loading' synchronously, so showIframe is false and the loader overlay is
    // never reached: the surface lands on the host BlockFallback, not an endless
    // spinner. (The mint-failure → terminal mapping is unit-covered by
    // pageBlockHostLogic.pageFallbackReason; here we assert the host surfaces it
    // INSTEAD of the loading indicator.)
    renderWithProviders(
      <PageBlockHost {...baseProps} token={null} tokenError onConsentGranted={vi.fn()} />
    );

    // Terminal fallback is rendered …
    await expect.element(page.getByTestId('app-page-fallback')).toBeInTheDocument();
    // … and the loading indicator is NOT present (no infinite spinner).
    expect(page.getByTestId('app-page-loading').query()).toBeNull();
  });

  // The loader must clear on EVERY terminal status the host's real status machine
  // can reach — not just `error`. These drive each terminal transition through the
  // host's actual code path (BLOCK_ERROR message, the BLOCK_READY-timeout, the
  // token-wait timeout) and assert the overlay unmounts (so it can never spin
  // forever). `fatal` is message-driven (fast); `timeout`/`no_token` are
  // real-timer driven (BLOCK_READY_TIMEOUT_MS=10s, TOKEN_WAIT_TIMEOUT_MS=15s) so
  // each is given a per-test timeout above its trigger window.

  test('loader clears after BLOCK_ERROR{fatal:true} (fatal terminal path)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);

    // Loader present while loading, then drive to ready (fatal is reachable from
    // both 'loading' and 'ready'; we go through ready as a real block would).
    await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();
    await driveToReady();
    await vi.waitFor(() => {
      expect(page.getByTestId('app-page-loading').query()).toBeNull();
    });

    // A fatal block error flips status → 'fatal'; showIframe becomes false and the
    // host renders the BlockFallback. The loader must stay gone (never re-spin).
    postFromBlock('BLOCK_ERROR', { fatal: true });
    await expect.element(page.getByTestId('app-page-fallback')).toBeInTheDocument();
    expect(page.getByTestId('app-page-loading').query()).toBeNull();
  });

  test('loader clears after the BLOCK_READY timeout (timeout terminal path)', async () => {
    // token present so the init controller arms its readiness timeout, but we
    // NEVER ack BLOCK_READY → after BLOCK_READY_TIMEOUT_MS (10s) onReadyTimeout
    // flips status 'loading' → 'timeout', clearing the loader and rendering the
    // fallback.
    useFakeClock();
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);

    await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();

    // Jump the 10s readiness window on the fake clock instead of sleeping through it.
    await advancePastWindow(11_000);
    // The loader must clear and the timeout fallback render.
    await vi.waitFor(
      () => {
        expect(page.getByTestId('app-page-loading').query()).toBeNull();
      },
      { timeout: 5_000, interval: 100 }
    );
    await expect.element(page.getByTestId('app-page-fallback')).toBeInTheDocument();
  }, 20_000);

  test('loader clears after the token-wait timeout (no_token terminal path)', async () => {
    // token=null and tokenError=false → no init controller (shouldStartInit
    // needs a token) and no synchronous error flip; the token-wait effect's
    // TOKEN_WAIT_TIMEOUT_MS (15s) timer flips status 'loading' → 'no_token',
    // clearing the loader and rendering the fallback. (With a null token the
    // iframe still mounts in the loading state, so the overlay is shown first.)
    useFakeClock();
    renderWithProviders(
      <PageBlockHost {...baseProps} token={null} tokenError={false} onConsentGranted={vi.fn()} />
    );

    await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();

    await advancePastWindow(16_000);
    await vi.waitFor(
      () => {
        expect(page.getByTestId('app-page-loading').query()).toBeNull();
      },
      { timeout: 5_000, interval: 100 }
    );
    await expect.element(page.getByTestId('app-page-fallback')).toBeInTheDocument();
  }, 25_000);
});

// Drive the host to the `fatal` terminal state via its REAL status machine:
// reach ready, then post BLOCK_ERROR{fatal:true}. Fast (message-driven), so the
// retry tests don't pay the 10s/15s real-timer windows.
async function driveToFatal() {
  await driveToReady();
  postFromBlock('BLOCK_ERROR', { fatal: true });
  await pollFor('terminal fallback', () => fallbackElQuery() !== null);
  // Let the auto-retry scheduling effect arm its backoff timer before anyone measures
  // from "now" — otherwise a caller under the virtual clock would take over BEFORE the
  // timer exists and could not claim it had cancelled a pending attempt.
  await advance(0);
}

describe('PageBlockHost terminal error surface (Task: readable error + Retry)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
  });

  // Each terminal state must render its OWN readable message AND a Retry button
  // — never the loader. `fatal`/`error` are fast (message/prop-driven);
  // `timeout`/`no_token` ride the real readiness/token-wait timers.

  test('fatal terminal state: readable "failed to load" message + Retry, not the loader', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);
    await driveToFatal();

    // Readable message (app name surfaced on the fatal path) — NOT "reported an error".
    await expect.element(page.getByText('Budgeted Generator failed to load')).toBeInTheDocument();
    // Retry button present.
    await expect.element(page.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // Loader is gone (no infinite spinner behind the fallback).
    expect(page.getByTestId('app-page-loading').query()).toBeNull();
  });

  test('error terminal state (mint failure): readable auth message + Retry, not the loader', async () => {
    renderWithProviders(
      <PageBlockHost {...baseProps} token={null} tokenError onConsentGranted={vi.fn()} />
    );
    await expect.element(page.getByTestId('app-page-fallback')).toBeInTheDocument();

    await expect.element(page.getByText("Couldn't authenticate this app")).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(page.getByTestId('app-page-loading').query()).toBeNull();
  });

  test('timeout terminal state: readable timeout message + Retry, not the loader', async () => {
    // token present, never ack BLOCK_READY → readiness timeout (10s) → 'timeout'.
    useFakeClock();
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);
    await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();

    await advancePastWindow(11_000);
    await vi.waitFor(
      () => {
        expect(page.getByTestId('app-page-fallback').query()).not.toBeNull();
      },
      { timeout: 5_000, interval: 100 }
    );
    await expect.element(page.getByText("This app didn't load in time")).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(page.getByTestId('app-page-loading').query()).toBeNull();
  }, 20_000);

  test('no_token terminal state: readable auth message + Retry, not the loader', async () => {
    // token=null, no error → token-wait timeout (15s) → 'no_token' → token_error copy.
    useFakeClock();
    renderWithProviders(
      <PageBlockHost {...baseProps} token={null} tokenError={false} onConsentGranted={vi.fn()} />
    );
    await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();

    await advancePastWindow(16_000);
    await vi.waitFor(
      () => {
        expect(page.getByTestId('app-page-fallback').query()).not.toBeNull();
      },
      { timeout: 5_000, interval: 100 }
    );
    await expect.element(page.getByText("Couldn't authenticate this app")).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(page.getByTestId('app-page-loading').query()).toBeNull();
  }, 25_000);
});

describe('PageBlockHost Retry (Task: re-attempt load from terminal fallback)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
  });

  test('clicking Retry returns to loading, remounts the iframe, and re-arms the handshake', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);
    await driveToFatal();

    // Capture the iframe element identity BEFORE retry so we can prove a real
    // remount (a NEW DOM node), not just a same-node src reload.
    const beforeEl = page.getByTestId('app-page-iframe').query() as HTMLIFrameElement | null;
    // While in the fatal fallback, the iframe is unmounted (showIframe=false).
    expect(beforeEl).toBeNull();

    await page.getByRole('button', { name: 'Retry' }).click();

    // Back to the loading state: the loader overlay is shown again and the
    // fallback is gone (no stuck terminal state).
    await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();
    expect(page.getByTestId('app-page-fallback').query()).toBeNull();

    // The iframe is remounted fresh (data-block-ready reset to 'false') so the
    // re-armed init handshake talks to a clean frame.
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
      if (!el.contentWindow) throw new Error('not remounted yet');
      if (el.getAttribute('data-block-ready') !== 'false') throw new Error('not reset yet');
    });
  });

  test('success-after-retry: a BLOCK_READY following Retry clears the fallback (no stuck state)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);
    await driveToFatal();

    await page.getByRole('button', { name: 'Retry' }).click();
    await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();

    // The re-armed handshake re-posts BLOCK_INIT; ack READY on the fresh frame.
    await driveToReady();

    // Fallback cleared, iframe ready, loader gone — recovered.
    expect(page.getByTestId('app-page-fallback').query()).toBeNull();
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    expect(el.getAttribute('data-block-ready')).toBe('true');
    // The launch veil now CROSS-FADES out over LAUNCH_REVEAL_MS once the block is
    // ready (the "subtly animated" launch experience) rather than disappearing in
    // the same commit, so poll for its removal instead of reading it synchronously.
    // It is still gated structurally — every terminal state unmounts it with the
    // whole iframe branch — so this can't mask a stuck spinner; the terminal-path
    // tests above (and PageBlockHostLaunchReveal.browser.test.tsx) pin that.
    await vi.waitFor(() => {
      expect(page.getByTestId('app-page-loading').query()).toBeNull();
    });
  });

  test('failure-after-retry: a second fatal error shows the fallback again (no timer leak / stuck state)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);
    await driveToFatal();

    await page.getByRole('button', { name: 'Retry' }).click();
    await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();

    // Drive the fresh frame to ready, then fail it AGAIN. The second failure must
    // route back to the fallback (the re-armed status machine still works).
    await driveToReady();
    postFromBlock('BLOCK_ERROR', { fatal: true });

    await expect.element(page.getByTestId('app-page-fallback')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(page.getByTestId('app-page-loading').query()).toBeNull();
  });
});

describe('PageBlockHost Retry re-mints the token on AUTH failures (the HIGH)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
  });

  // The token is a PROP minted upstream (useBlockToken in the route). For an
  // AUTH-failure terminal (`error` = hard mint failure, `no_token` = token never
  // arrived) the local reset + reloadNonce bump in handleRetry can NEVER recover
  // — `token`/`tokenError` are owned upstream, so the re-armed handshake just
  // times out to the SAME terminal again (the 15s dead-end). The fix calls
  // onRetryToken (= useBlockToken.refresh) to RE-MINT on those two states. These
  // tests pin that: Retry from error/no_token calls onRetryToken AND returns to
  // loading; Retry from fatal/timeout does NOT re-mint (remount-only path
  // unchanged). Mutation-sanity: deleting the `onRetryToken?.()` call from the
  // auth branch fails the first two tests.

  test('error (mint failure): Retry calls onRetryToken AND returns to loading', async () => {
    // VIRTUAL CLOCK, held across the click — `error` is an AUTH terminal, so a pending
    // automatic attempt would itself call onRetryToken and make the exactly-once
    // assertion below a race. See useVirtualClock.
    useVirtualClock();
    const onRetryToken = vi.fn();
    // token=null + tokenError → synchronous `error` terminal; fallback renders.
    renderWithProviders(
      <PageBlockHost
        {...baseProps}
        token={null}
        tokenError
        onConsentGranted={vi.fn()}
        onRetryToken={onRetryToken}
      />
    );
    await pollFor('terminal fallback', () => fallbackElQuery() !== null);
    // Let the auto-retry effect arm its backoff timer, so the click below is provably a
    // takeover of a PENDING attempt rather than a race with one that may not exist yet.
    await advance(0);
    expect(onRetryToken).not.toHaveBeenCalled();

    await page.getByRole('button', { name: 'Retry' }).click();

    // The token re-mint fired exactly once (the auth-recovery path) …
    expect(onRetryToken).toHaveBeenCalledTimes(1);
    // … and the host returned to the loading state (the local re-arm still runs).
    await pollFor('retry loading surface', () => loadingElQuery() !== null);
    expect(fallbackElQuery()).toBeNull();
  });

  test('no_token (token never arrived): Retry calls onRetryToken AND returns to loading', async () => {
    const onRetryToken = vi.fn();
    // token=null, no error → token-wait timeout (15s) → `no_token` terminal.
    //
    // 🔴 This used `useFakeClock()` + `advancePastWindow()`, which LOOKS like it covers
    // the click but does not: `advancePastWindow` restores REAL timers on the way out by
    // design, so the click and every assertion after it ran on the real clock and raced
    // the 2s auto-retry backoff. `no_token` is an AUTH terminal, so that automatic
    // attempt re-mints — it moves the exact counter asserted below.
    useVirtualClock();
    renderWithProviders(
      <PageBlockHost
        {...baseProps}
        token={null}
        tokenError={false}
        onConsentGranted={vi.fn()}
        onRetryToken={onRetryToken}
      />
    );
    // The loader is the precondition — and it also guarantees the render has committed
    // (so the product's token-wait timer is on the virtual clock) before we advance it.
    await pollFor('loading surface', () => loadingElQuery() !== null);
    // 🔴 Advance to the window's EXACT boundary and let `pollFor` nudge the remainder,
    // rather than over-shooting by a round second. Virtual time spent AFTER the terminal
    // is reached is spent against the auto-retry backoff, so a generous over-shoot
    // re-creates from inside the test exactly the pending-attempt-already-fired state
    // this conversion exists to rule out. `pollFor` nudges 1ms at a time.
    await advance(TOKEN_WAIT_TIMEOUT_MS);
    await pollFor('terminal fallback', () => fallbackElQuery() !== null);
    // Arm the auto-retry backoff before taking over (see the `error` test above).
    await advance(0);
    expect(onRetryToken).not.toHaveBeenCalled();

    await page.getByRole('button', { name: 'Retry' }).click();

    expect(onRetryToken).toHaveBeenCalledTimes(1);
    await pollFor('retry loading surface', () => loadingElQuery() !== null);
    expect(fallbackElQuery()).toBeNull();
  }, 25_000);

  test('fatal (non-auth): Retry returns to loading + remounts but does NOT re-mint the token', async () => {
    // VIRTUAL CLOCK, held across the click. `fatal` is NOT an auth terminal, so a
    // pending automatic attempt would not move `onRetryToken` — but it WOULD flip the
    // status to 'loading' mid-click, at which point `handleRetry`'s double-click guard
    // makes the click a no-op and the host later settles on the `timeout` terminal
    // instead. Every assertion below still passes, so the test goes GREEN while
    // exercising a DIFFERENT branch than its name claims. Measured: shrinking the first
    // backoff to 50ms takes this test from 200ms to 10531ms (it waits out a whole
    // BLOCK_READY window) and it still reports a pass. The virtual clock removes the
    // substitution rather than making it louder.
    useVirtualClock();
    const onRetryToken = vi.fn();
    // token PRESENT; drive to the `fatal` terminal via a block error. The token
    // was fine — so Retry must remount only, never call onRetryToken.
    renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={onRetryToken} />
    );
    await driveToFatal();

    await page.getByRole('button', { name: 'Retry' }).click();

    // Remount-only path is unchanged: back to loading, fresh iframe, NO re-mint.
    await pollFor('retry loading surface', () => loadingElQuery() !== null);
    expect(fallbackElQuery()).toBeNull();
    await pollFor('fresh iframe mount', () => {
      const el = iframeElQuery();
      return !!el?.contentWindow && el.getAttribute('data-block-ready') === 'false';
    });
    expect(onRetryToken).not.toHaveBeenCalled();
  });

  test('timeout (non-auth): Retry returns to loading but does NOT re-mint the token', async () => {
    const onRetryToken = vi.fn();
    // token present, never ack BLOCK_READY → readiness timeout (10s) → `timeout`.
    //
    // 🔴 Same trap as the `no_token` test: this used `useFakeClock()` +
    // `advancePastWindow()`, which restores REAL timers on the way out, so the click ran
    // on the real clock against the 2s auto-retry backoff.
    useVirtualClock();
    renderWithProviders(
      <PageBlockHost {...baseProps} onConsentGranted={vi.fn()} onRetryToken={onRetryToken} />
    );
    // The loader is the precondition — and it also guarantees the render has committed
    // (so the product's readiness timer is on the virtual clock) before we advance it.
    await pollFor('loading surface', () => loadingElQuery() !== null);
    // Exact boundary + `pollFor` nudges — see the note in the `no_token` test above.
    await advance(BLOCK_READY_TIMEOUT_MS);
    await pollFor('terminal fallback', () => fallbackElQuery() !== null);
    // Arm the auto-retry backoff before taking over (see the `error` test above).
    await advance(0);

    await page.getByRole('button', { name: 'Retry' }).click();

    await pollFor('retry loading surface', () => loadingElQuery() !== null);
    expect(fallbackElQuery()).toBeNull();
    // Token was fine on a timeout → no re-mint (remount-only path unchanged).
    expect(onRetryToken).not.toHaveBeenCalled();
  }, 20_000);
});

describe('PageBlockHost block render/impression (Analytics Phase 2)', () => {
  // Analytics Phase 2 now emits via the /api/track/block-render BEACON
  // (sendBlockRender → fetch), not a tRPC mutation. Spy on global fetch and
  // assert the beacon fires exactly once at BLOCK_READY (and never on re-render).
  //
  // 🔴 THIS DESCRIBE IS ALSO THE BATCHING-INDEPENDENCE GUARD for the beacon, and
  // that is why it must keep rendering the REAL host with REAL hooks (no
  // `@mantine/hooks` mock in this file). The beacon used to fire from inside the
  // BLOCK_READY handler behind a flag set by the `setStatus` UPDATER, which only
  // works while React can evaluate that updater EAGERLY — i.e. while nothing else
  // is queued on the fiber. `useReducedMotion` (added by the launch-reveal work)
  // commits its value in a post-mount effect, which is exactly such a pending
  // update, and it made the impression drop 5/5 runs. The beacon now keys off the
  // COMMITTED `status`. Mutation-verified: restoring the in-handler `acked`
  // pattern fails the first test below, deterministically.
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  // Only the block-render beacon goes through fetch in this test; resolve OK.
  function isBeacon(call: unknown[]) {
    return typeof call[0] === 'string' && (call[0] as string).includes('/api/track/block-render');
  }
  function beaconCalls() {
    return fetchSpy.mock.calls.filter(isBeacon);
  }

  beforeEach(() => {
    // vi.spyOn dedupes to the same mock when fetch is already spied, so its
    // .mock.calls would accumulate across tests — clear it each time.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    fetchSpy.mockClear();
  });

  test('emits the block-render beacon exactly once at BLOCK_READY with the page identifiers', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);

    // Not emitted before the handshake completes.
    expect(beaconCalls()).toHaveLength(0);

    await driveToReady();

    await vi.waitFor(() => {
      expect(beaconCalls()).toHaveLength(1);
    });

    const [url, init] = beaconCalls()[0];
    expect(url).toBe('/api/track/block-render');
    expect((init as RequestInit | undefined)?.method).toBe('POST');
    // keepalive so the beacon survives a page unload/navigation.
    expect((init as RequestInit | undefined)?.keepalive).toBe(true);
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      appBlockId: 'apb_test',
      blockInstanceId: 'page_apb_test',
      slotId: 'app.page',
    });
    // 🔴 LAUNCH TIMINGS RIDE THIS BEACON — there is still exactly ONE beacon and
    // the `ok` path still carries no `status`. The allowed key set is pinned so a
    // future field cannot be added to the wire unnoticed.
    expect(Object.keys(body).sort()).toEqual(
      ['appBlockId', 'blockInstanceId', 'slotId', 'timings'].sort()
    );
    expect(typeof body.timings.totalMs).toBe('number');
    expect(body.timings.totalMs).toBeGreaterThan(0);
    // 🔴 NO STRINGS ON THE WIRE — this is the real invariant, and it is what
    // keeps a public, client-controlled beacon body from touching prom label
    // cardinality. Every label this payload feeds is CODE-OWNED: the server maps
    // named numeric fields onto its own `phase` literals and the `hello` boolean
    // onto `yes`/`no`, so no value here can ever BE a label value.
    //
    // It used to be written as "every field is a number", which was the same
    // rule while every field happened to be one. `hello` is a BOOLEAN and does
    // not weaken the guarantee — booleans are a closed two-value domain, mapped
    // server-side — so the assertion is restated at the level of the property it
    // was always protecting rather than relaxed to let a boolean through.
    for (const [k, v] of Object.entries(body.timings)) {
      expect(typeof v, `timings.${k}`).not.toBe('string');
      expect(['number', 'boolean'], `timings.${k}`).toContain(typeof v);
      // Never a zero-valued NUMERIC leg on the wire — an unobserved leg is
      // OMITTED, because a 0 is indistinguishable from an instant one and drags
      // every percentile down. Booleans are exempt: `hello: false` is a real
      // observation, not a missing one, and is emitted deliberately (an omitted
      // field would be indistinguishable from a client that cannot send it).
      if (typeof v === 'number') expect(v, `timings.${k}`).toBeGreaterThan(0);
    }
    // `hello` specifically: always present, always boolean.
    expect(typeof body.timings.hello, 'timings.hello').toBe('boolean');
    // No isAnon/userId from the client — those are server-derived in the route.
    expect(body).not.toHaveProperty('isAnon');
    expect(body).not.toHaveProperty('userId');
  });

  test('does NOT re-emit on a late/duplicate BLOCK_READY (status no longer loading)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);

    await driveToReady();
    await vi.waitFor(() => expect(beaconCalls()).toHaveLength(1));

    // A second BLOCK_READY (block re-ack, or a re-render re-running listeners)
    // finds status === 'ready', so the `acked` gate stays false → no re-emit.
    postFromBlock('BLOCK_READY', {});
    postFromBlock('BLOCK_READY', {});
    await new Promise((r) => setTimeout(r, 150));

    expect(beaconCalls()).toHaveLength(1);
  });

  // Per-mount semantics guard: a GENUINE remount (the host re-mounted under a
  // CHANGED key — what happens on model navigation / tab switch) must create a
  // FRESH emit-once ref and therefore emit AGAIN. Without this assertion a
  // future change that makes `blockRenderEmittedRef` persistent (e.g. hoisting
  // it to a module/global) would silently UNDER-count impressions and no test
  // would catch it. We bump a React-state key around the host (a real unmount +
  // remount, not a re-render) and assert a 2nd beacon.
  function RemountHarness({ onSetKey }: { onSetKey: (set: (k: number) => void) => void }) {
    const [k, setK] = useState(0);
    onSetKey(setK);
    // The key is on PageBlockHost so changing it unmounts+remounts ONLY the host
    // (fresh refs/effects) while the surrounding providers/QueryClient persist —
    // exactly a model-navigation remount.
    return <PageBlockHost key={k} {...baseProps} onConsentGranted={vi.fn()} />;
  }

  test('re-emits on a genuine remount under a new key (fresh emit-once ref)', async () => {
    let bumpKey: (k: number) => void = () => undefined;
    renderWithProviders(<RemountHarness onSetKey={(set) => (bumpKey = set)} />);

    // First mount → exactly one beacon.
    await driveToReady();
    await vi.waitFor(() => expect(beaconCalls()).toHaveLength(1));

    // Remount under a NEW key — tears down the host and mounts a fresh instance
    // with a brand-new `blockRenderEmittedRef`.
    bumpKey(1);

    // The fresh mount starts in 'loading' (data-block-ready='false'). Wait for
    // that reset so driveToReady() drives the NEW instance, not a stale 'true'
    // node from the prior mount.
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
      if (el.getAttribute('data-block-ready') !== 'false') throw new Error('not reset yet');
    });

    // The fresh instance re-runs the whole handshake; ack BLOCK_READY again.
    await driveToReady();

    // The new mount emitted a 2nd, independent impression → total 2.
    await vi.waitFor(() => expect(beaconCalls()).toHaveLength(2));
  });
});

/**
 * The readiness-announce SEAM on the PAGE host. Mirrors the model-slot coverage
 * in IframeHost.browser.test.tsx — each host is a separate call site, so each
 * needs its own proof that a real postMessage reaches the controller.
 */
describe('PageBlockHost readiness announce (BLOCK_HELLO)', () => {
  async function mountAndWait() {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
      if (!el.contentWindow) throw new Error('not mounted yet');
    });
  }

  test('a BLOCK_HELLO from the frame reaches IframeInitController.notifyHello', async () => {
    const helloSpy = vi.spyOn(IframeInitController.prototype, 'notifyHello');
    await mountAndWait();
    expect(helloSpy).not.toHaveBeenCalled(); // positive control

    postFromBlock('BLOCK_HELLO');

    await vi.waitFor(() => expect(helloSpy).toHaveBeenCalled());
    helloSpy.mockRestore();
  });

  test('an unrelated message type does NOT reach notifyHello (negative control)', async () => {
    const helloSpy = vi.spyOn(IframeInitController.prototype, 'notifyHello');
    await mountAndWait();

    postFromBlock('BLOCK_HELLO_NOT_REALLY');
    await new Promise((r) => setTimeout(r, 150));
    expect(helloSpy).not.toHaveBeenCalled();
    helloSpy.mockRestore();
  });
});
