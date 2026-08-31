import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only (erased at runtime, so it can't defeat vi.mock hoisting) — lets the
// `importOriginal` generic below be written without an inline `import()` type,
// which the repo's `consistent-type-imports` rule forbids.
import type * as MantineHooks from '@mantine/hooks';

/**
 * W10 run-page LAUNCH EXPERIENCE (product feedback #3: "launching an app should
 * feel magical and be a delightful, intuitive, simple and subtly animated
 * experience").
 *
 * What shipped: a BRANDED launch state (the app's initial + name, not a bare
 * spinner) that cross-fades out as the block fades/settles in on BLOCK_READY.
 * Implemented with plain CSS transitions (the `motion` package is not in the
 * `/apps` route graph — see the LAUNCH_REVEAL_MS comment in PageBlockHost).
 *
 * 🔴 THE INVARIANT THESE TESTS EXIST FOR: the reveal must never delay, mask or
 * swallow an error. The host has FOUR terminal states — `timeout` (the ~10s
 * BLOCK_READY timer), `fatal` (BLOCK_ERROR), `no_token` (the ~15s token wait) and
 * `error` (a hard mint failure) — and each must still surface promptly AND stay
 * wrapped in `AppBlockChrome` (the FRAME-1 invariant: a block must not be able to
 * shed its provenance chrome by never sending BLOCK_READY). The sharpest case is
 * an error that lands DURING the reveal window; it has its own test below.
 *
 * `prefers-reduced-motion: reduce` must instant-ify everything: no transition is
 * emitted on either the veil or the iframe.
 */

const mocks = vi.hoisted(() => ({ reduceMotion: false }));

// The reveal reads `useReducedMotion()`; drive it deterministically instead of
// depending on the headless browser's media state. Spread the real module so
// every OTHER @mantine/hooks consumer in PageBlockHost's graph is untouched.
vi.mock('@mantine/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof MantineHooks>();
  return { ...actual, useReducedMotion: () => mocks.reduceMotion };
});

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
        // Was MISSING: PageBlockHost calls `trpc.apps.shared.report.useMutation()`
        // unconditionally at render, so without this stub every test in this file
        // crashed at mount with "Cannot read properties of undefined (reading
        // 'useMutation')". These checks are report-only, so the whole suite — the
        // guard for the launch-reveal invariants — had been silently red.
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
import { LAUNCH_REVEAL_MS, PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

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

const iframeEl = () => page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
const overlayEl = () => page.getByTestId('app-page-loading').element() as HTMLElement;

beforeEach(() => {
  mocks.reduceMotion = false;
});

describe('PageBlockHost launch reveal — branded loading', () => {
  test('the launch state is BRANDED (app initial + name), not a bare spinner', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);

    await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();
    // The app's own name, echoing the store card the user just came from.
    await expect.element(page.getByText('Starting Budgeted Generator…')).toBeInTheDocument();
    // Its initial, in the same Avatar treatment the store card uses.
    await expect.element(page.getByText('B', { exact: true })).toBeInTheDocument();
    // The existing a11y contract is preserved: a busy live REGION, plus a
    // labelled graphic.
    const overlay = overlayEl();
    expect(overlay.getAttribute('role')).toBe('status');
    expect(overlay.getAttribute('aria-busy')).toBe('true');
    await expect.element(page.getByLabelText('Loading Budgeted Generator')).toBeInTheDocument();
  });

  test('the branded copy runs appName through the chrome sanitizer (control/bidi stripped)', async () => {
    // Same anti-spoof posture as the existing aria-label test: the publisher
    // controls appName, so every appName-derived string on this surface — now
    // including the VISIBLE "Starting …" line and the avatar initial — goes
    // through sanitizeAppChromeName.
    const spoofed = 'Evil' + String.fromCharCode(0x09) + String.fromCharCode(0x202e) + 'App';
    renderWithProviders(
      <PageBlockHost {...baseProps} appName={spoofed} onConsentGranted={vi.fn()} />
    );
    await expect.element(page.getByText('Starting Evil App…')).toBeInTheDocument();
  });
});

describe('PageBlockHost launch reveal — reveal on ready', () => {
  test('the block is hidden while handshaking and REVEALED (with a transition) on BLOCK_READY', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);

    await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();
    // Pre-handshake: the frame is transparent + inert behind the launch veil, and
    // the reveal transition is armed.
    const before = iframeEl();
    expect(before.style.opacity).toBe('0');
    expect(before.style.pointerEvents).toBe('none');
    expect(before.style.transition).toContain('opacity');
    // The veil itself cross-fades and never intercepts a click.
    const veil = overlayEl();
    expect(veil.style.transition).toContain('opacity');
    expect(veil.style.pointerEvents).toBe('none');

    await driveToReady();

    // Revealed: fully opaque, settled, interactive.
    const after = iframeEl();
    expect(after.style.opacity).toBe('1');
    expect(after.style.transform).toBe('none');
    expect(after.style.pointerEvents).toBe('auto');
    expect(after.style.transition).toContain('opacity');

    // …and the launch veil finishes its fade and unmounts (it can never linger).
    await vi.waitFor(() => {
      expect(page.getByTestId('app-page-loading').query()).toBeNull();
    });
  });

  test('while fading out, the veil is hidden from the a11y tree (no stale "loading" announcement)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);
    await driveToReady();
    // The veil may already be unmounted (fast machine) — either way it must NOT
    // still be announcing itself as a busy live region.
    const el = page.getByTestId('app-page-loading').query();
    if (el) {
      expect(el.getAttribute('aria-hidden')).toBe('true');
      expect(el.getAttribute('role')).toBeNull();
      expect((el as HTMLElement).style.opacity).toBe('0');
    }
    await vi.waitFor(() => {
      expect(page.getByTestId('app-page-loading').query()).toBeNull();
    });
  });
});

describe('PageBlockHost launch reveal — prefers-reduced-motion', () => {
  test('reduced motion emits NO transition on either the veil or the block', async () => {
    mocks.reduceMotion = true;
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);

    await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();
    // The branded content still renders — reduced motion removes MOTION, not the
    // loading state.
    await expect.element(page.getByText('Starting Budgeted Generator…')).toBeInTheDocument();

    expect(iframeEl().style.transition).toBe('');
    expect(iframeEl().style.transform).toBe('none');
    expect(overlayEl().style.transition).toBe('');
  });

  test('reduced motion still reveals the block and drops the veil on ready', async () => {
    mocks.reduceMotion = true;
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);
    await driveToReady();
    expect(iframeEl().style.opacity).toBe('1');
    expect(iframeEl().style.transition).toBe('');
    await vi.waitFor(() => {
      expect(page.getByTestId('app-page-loading').query()).toBeNull();
    });
  });
});

describe('PageBlockHost launch reveal — the reveal must NOT gate the error path', () => {
  // 🔴 The bug class this whole describe exists to catch: a reveal wrapper that
  // holds the surface in "launching" while a terminal state is pending, so a
  // block that never signals ready renders a pretty spinner forever instead of an
  // error. Every terminal path is asserted to (a) reach BlockFallback and (b)
  // still be wrapped in AppBlockChrome.

  test('fatal DURING the reveal window still lands on the fallback, promptly, inside the chrome', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);
    await driveToReady();
    // Fire the error IMMEDIATELY — inside the cross-fade window, before the veil
    // has finished fading out. The fallback must not wait on the animation.
    const firedAt = Date.now();
    postFromBlock('BLOCK_ERROR', { fatal: true });

    // 🔴 PROMPTNESS. Measured against a captured timestamp rather than a bare
    // sleep: `driveToReady()` above can itself consume part of the reveal window
    // on a slow box, so "sleep 50ms then assert" could accidentally land AFTER a
    // reveal-gated fallback had already faded in and pass despite the bug. Here
    // we poll for the fallback and then assert it arrived in well under
    // LAUNCH_REVEAL_MS as measured from the moment the error was fired — which a
    // reveal-gated fallback cannot satisfy no matter how the earlier steps were
    // scheduled. Mutation-verified: gating the fallback on the reveal timer fails
    // this assertion.
    await vi.waitFor(
      () => {
        expect(page.getByTestId('app-page-fallback').query()).not.toBeNull();
      },
      { timeout: 2000, interval: 5 }
    );
    expect(Date.now() - firedAt).toBeLessThan(LAUNCH_REVEAL_MS);
    // FRAME-1: provenance chrome still wraps the fallback.
    await expect.element(page.getByTestId('app-block-chrome')).toBeInTheDocument();
    // The launch surface is gone — no spinner, no lingering veil, no iframe.
    expect(page.getByTestId('app-page-loading').query()).toBeNull();
    expect(page.getByTestId('app-page-iframe').query()).toBeNull();
  });

  test('the `error` terminal (hard mint failure) renders the fallback inside the chrome, never the launch state', async () => {
    renderWithProviders(
      <PageBlockHost {...baseProps} token={null} tokenError onConsentGranted={vi.fn()} />
    );
    await expect.element(page.getByTestId('app-page-fallback')).toBeInTheDocument();
    await expect.element(page.getByTestId('app-block-chrome')).toBeInTheDocument();
    expect(page.getByTestId('app-page-loading').query()).toBeNull();
  });

  test('the `timeout` terminal (block never acks BLOCK_READY) renders the fallback inside the chrome', async () => {
    // Token present so the init controller arms its readiness timeout, but we
    // never ack BLOCK_READY → after BLOCK_READY_TIMEOUT_MS the host goes
    // terminal. The branded launch state must NOT survive it.
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);
    await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();

    await vi.waitFor(
      () => {
        expect(page.getByTestId('app-page-fallback').query()).not.toBeNull();
      },
      { timeout: 14_000, interval: 250 }
    );
    await expect.element(page.getByTestId('app-block-chrome')).toBeInTheDocument();
    expect(page.getByTestId('app-page-loading').query()).toBeNull();
  }, 20_000);

  test('the `no_token` terminal (token never arrives) renders the fallback inside the chrome', async () => {
    renderWithProviders(
      <PageBlockHost {...baseProps} token={null} tokenError={false} onConsentGranted={vi.fn()} />
    );
    await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();

    await vi.waitFor(
      () => {
        expect(page.getByTestId('app-page-fallback').query()).not.toBeNull();
      },
      { timeout: 19_000, interval: 250 }
    );
    await expect.element(page.getByTestId('app-block-chrome')).toBeInTheDocument();
    expect(page.getByTestId('app-page-loading').query()).toBeNull();
  }, 26_000);
});
