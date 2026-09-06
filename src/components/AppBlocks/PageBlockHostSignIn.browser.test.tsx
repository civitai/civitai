import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { onReadyAttributeWrite } from '../../../test/commitWindow';

/**
 * W10 sign-in-bridge gap regression (page surface).
 *
 * The page route (`/apps/run/<slug>`) renders for LOGGED-OUT viewers (the
 * BLOCK_INIT context is viewer-scoped, viewer:null when anon). A block that
 * needs auth/money asks the host to start the civitai login flow via
 * REQUEST_SIGN_IN on the user's click. Before this fix the sign-in bridge was
 * only wired into the model-slot host (IframeHost); PageBlockHost never handled
 * REQUEST_SIGN_IN, so a logged-out viewer's action dead-ended (login never
 * started). The shared resolveRequestSignIn gate pins status === 'ready' +
 * sanitises a same-origin returnUrl, then starts the hub login via openLoginPopup
 * (fire-and-forget, no host→block reply).
 *
 * We assert against the stubbed openLoginPopup (login is a popup to the hub now —
 * the old in-page LoginModal was removed in the auth cutover). The pure gate
 * (readiness + returnUrl sanitisation) is covered by requestSignInGate unit
 * tests; this is the host-integration layer.
 */

// trpc is mocked so PageBlockHost's workflow + storage bridges mount network-free
// (inert stubs here — exercised in their own suites).
// AppBlockChrome (in the host frame) calls useCurrentUser() for the platform-nav
// moderator gate; these suites render the real host without a CivitaiSessionProvider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', () => ({
  // FeatureFlagsProvider (in PageBlockHost's real render graph) statically imports
  // `setTrpcBatchingEnabled` from this module (#2946). vi.mock replaces the module
  // wholesale, so the factory must re-declare it or the ESM link fails and the whole
  // test file fails to import.
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

// Login is hub-driven now (a popup to auth.civitai.com via openLoginPopup) — the old in-page
// LoginModal was removed in the auth cutover. Stub openLoginPopup so REQUEST_SIGN_IN assertions
// check the call args without actually opening a window.
vi.mock('~/utils/auth-helpers', async (importActual) => ({
  ...(await importActual<typeof import('~/utils/auth-helpers')>()),
  openLoginPopup: vi.fn(),
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
// eslint-disable-next-line import/first
import { openLoginPopup } from '~/utils/auth-helpers';

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

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

// An ANONYMOUS viewer — the page route renders the host for logged-out users, so
// viewer:null is the case the sign-in bridge exists for.
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
  declaredScopes: ['ai:write:budgeted'],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: null,
  theme: 'light' as const,
};

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

/**
 * Wait for the iframe to mount, then post BLOCK_READY on a CANCELLABLE interval.
 *
 * Cancellable is load-bearing: a drive left running past the end of a test posts
 * BLOCK_READY into the NEXT test's freshly-mounted host — measured, that turned the
 * "before BLOCK_READY is dropped" guard below red for a reason having nothing to do
 * with the race under study. Callers stop it in a `finally`.
 */
async function startReadyDrive() {
  await vi.waitFor(() => {
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (!el.contentWindow) throw new Error('not mounted yet');
  });
  const timer = setInterval(() => postFromBlock('BLOCK_READY', {}), 10);
  postFromBlock('BLOCK_READY', {});
  return () => clearInterval(timer);
}

describe('PageBlockHost REQUEST_SIGN_IN (W10 anonymous-conversion wiring)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    vi.mocked(openLoginPopup).mockClear();
  });

  /**
   * REGRESSION GUARD for the host-ready stale-closure race.
   *
   * REQUEST_SIGN_IN is fire-and-forget — it carries no requestId and has no reply
   * message — so a post dropped in this window is gone for good and the anonymous
   * viewer's click on "Sign in" does nothing at all, silently. There is no NACK
   * available to soften it, which is exactly why the root-cause fix (reading a
   * render-body-updated `statusRef` instead of a closed-over `status`) has to hold
   * for this handler.
   *
   * 🔴 The post is driven from `onReadyAttributeWrite`, NOT from a MutationObserver.
   * That is the difference between a guard and a coin flip — see test/commitWindow.tsx
   * for the two approaches that were measured and rejected. The short version: a
   * MutationObserver callback is a microtask that runs at the END of the scheduler
   * task, by which point React has often already flushed the passive effects, so the
   * first version of this guard survived the mutant roughly one run in three.
   *
   * Proven reachable by mutation: move `statusRef.current = status` out of the render
   * body and back into an effect and this goes red on `expected "openLoginPopup" to
   * be called 1 times, but got 0 times`.
   */
  test("REQUEST_SIGN_IN posted in React's commit→passive-effect gap still starts the login", async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    // Fires synchronously on React's own stack, at the instant the host writes
    // data-block-ready="true" — strictly before this commit's passive effects
    // re-register a listener holding the fresh status.
    const unpatch = onReadyAttributeWrite(() => postFromBlock('REQUEST_SIGN_IN', {}));
    try {
      const stopDrive = await startReadyDrive();
      try {
        await vi.waitFor(() => {
          expect(openLoginPopup).toHaveBeenCalledTimes(1);
        });
      } finally {
        stopDrive();
      }
    } finally {
      unpatch();
    }
  });

  test('after BLOCK_READY, REQUEST_SIGN_IN starts the hub login (defaults to the current page)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    expect(openLoginPopup).not.toHaveBeenCalled();

    postFromBlock('REQUEST_SIGN_IN', {});

    await vi.waitFor(() => {
      expect(openLoginPopup).toHaveBeenCalledTimes(1);
    });
    // No returnUrl supplied → the host falls back to the current page; reason is forwarded.
    const here = window.location.pathname + window.location.search + window.location.hash;
    expect(openLoginPopup).toHaveBeenCalledWith(here, 'image-gen');
  });

  test('REQUEST_SIGN_IN honors a safe same-origin returnUrl', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('REQUEST_SIGN_IN', { returnUrl: '/apps/run/my-page-app/editor' });

    await vi.waitFor(() => {
      expect(openLoginPopup).toHaveBeenCalledTimes(1);
    });
    expect(openLoginPopup).toHaveBeenCalledWith('/apps/run/my-page-app/editor', 'image-gen');
  });

  test('REQUEST_SIGN_IN drops an unsafe absolute returnUrl (open-redirect guard)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    // Absolute / protocol-relative returnUrl is rejected by the shared gate → the host
    // falls back to the current page, so the post-login redirect can't bounce off-site.
    postFromBlock('REQUEST_SIGN_IN', { returnUrl: 'https://evil.com/steal' });

    const here = window.location.pathname + window.location.search + window.location.hash;
    await vi.waitFor(() => {
      expect(openLoginPopup).toHaveBeenCalledTimes(1);
    });
    expect(openLoginPopup).toHaveBeenCalledWith(here, 'image-gen');
    expect(openLoginPopup).not.toHaveBeenCalledWith('https://evil.com/steal', expect.anything());
  });

  test('REQUEST_SIGN_IN before BLOCK_READY is dropped (no pre-handshake login modal)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    // Do NOT drive to ready — fire while status is still 'loading'.
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
      if (!el.contentWindow) throw new Error('not mounted yet');
    });

    postFromBlock('REQUEST_SIGN_IN', {});

    await new Promise((r) => setTimeout(r, 150));
    expect(openLoginPopup).not.toHaveBeenCalled();
  });
});
