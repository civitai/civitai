import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W10 sign-in-bridge gap regression (page surface).
 *
 * The page route (`/apps/run/<slug>`) renders for LOGGED-OUT viewers (the
 * BLOCK_INIT context is viewer-scoped, viewer:null when anon). A block that
 * needs auth/money asks the host to start the civitai login flow via
 * REQUEST_SIGN_IN on the user's click. Before this fix the sign-in bridge was
 * only wired into the model-slot host (IframeHost); PageBlockHost never handled
 * REQUEST_SIGN_IN, so a logged-out viewer's action dead-ended (the login modal
 * never opened). We mirror IframeHost EXACTLY: the shared resolveRequestSignIn
 * gate pins status === 'ready' + sanitises a same-origin returnUrl, then opens
 * LoginModal via the shared dialogStore (fire-and-forget, no host→block reply).
 *
 * We assert against the shared dialogStore (the same store IframeHost's sign-in
 * handler triggers) rather than rendering the modal, since LoginModal pulls in
 * client-only providers — same posture as the consent + buzz tests. The pure
 * gate (readiness + returnUrl sanitisation) is covered by requestSignInGate
 * unit tests; this is the host-integration layer.
 */

// trpc is mocked so PageBlockHost's workflow + storage bridges mount network-free
// (inert stubs here — exercised in their own suites).
vi.mock('~/utils/trpc', () => ({
  trpc: {
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    apps: {
      storage: {
        set: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        delete: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
    },
    useUtils: () => ({
      apps: {
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

describe('PageBlockHost REQUEST_SIGN_IN (W10 anonymous-conversion wiring)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
  });

  test('after BLOCK_READY, REQUEST_SIGN_IN opens the LoginModal', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    expect(useDialogStore.getState().dialogs).toHaveLength(0);

    postFromBlock('REQUEST_SIGN_IN', {});

    await vi.waitFor(() => {
      expect(useDialogStore.getState().dialogs).toHaveLength(1);
    });
    // No returnUrl supplied → LoginModal defaults to the current page (the host
    // omits the prop). reason is forwarded.
    const dialogProps = useDialogStore.getState().dialogs[0].props as {
      reason?: string;
      returnUrl?: string;
    };
    expect(dialogProps.reason).toBe('image-gen');
    expect(dialogProps.returnUrl).toBeUndefined();
  });

  test('REQUEST_SIGN_IN honors a safe same-origin returnUrl', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('REQUEST_SIGN_IN', { returnUrl: '/apps/run/my-page-app/editor' });

    await vi.waitFor(() => {
      expect(useDialogStore.getState().dialogs).toHaveLength(1);
    });
    const dialogProps = useDialogStore.getState().dialogs[0].props as { returnUrl?: string };
    expect(dialogProps.returnUrl).toBe('/apps/run/my-page-app/editor');
  });

  test('REQUEST_SIGN_IN drops an unsafe absolute returnUrl (open-redirect guard)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    // Absolute / protocol-relative returnUrl is rejected by the shared gate →
    // the host opens the modal WITHOUT a returnUrl (LoginModal defaults to the
    // current page), so the post-login redirect can't bounce off-site.
    postFromBlock('REQUEST_SIGN_IN', { returnUrl: 'https://evil.com/steal' });

    await vi.waitFor(() => {
      expect(useDialogStore.getState().dialogs).toHaveLength(1);
    });
    const dialogProps = useDialogStore.getState().dialogs[0].props as { returnUrl?: string };
    expect(dialogProps.returnUrl).toBeUndefined();
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
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
  });
});
