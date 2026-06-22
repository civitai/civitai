import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// Analytics Phase 2: shared spy for trpc.track.blockRender.useMutation().mutate,
// asserted to fire exactly once at BLOCK_READY (and never on re-render).
const { mockBlockRenderMutate } = vi.hoisted(() => ({ mockBlockRenderMutate: vi.fn() }));

// PageBlockHost wires the money-path workflow bridge AND the storage bridge,
// which call `trpc.blocks.*.useMutation()`, `trpc.apps.storage.*.useMutation()`,
// and `trpc.useUtils()` at render — that needs the tRPC Context (the `withTRPC`
// HoC) the network-free component scaffold doesn't provide. Mock the tRPC client
// so these consent-focused tests stay network-free and mount the component
// without a real tRPC provider. The workflow + storage bridges are exercised in
// PageBlockHostWorkflow / PageBlockHostStorage.browser.test.tsx; here they're
// inert stubs.
vi.mock('~/utils/trpc', () => ({
  trpc: {
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    track: {
      blockRender: { useMutation: () => ({ mutate: mockBlockRenderMutate }) },
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

// Drive the handshake to BLOCK_READY (status='ready') so the consent gate's
// `status === 'ready'` precondition is satisfied — same prerequisite a real
// block hits before its first Generate.
async function driveToReady() {
  // Wait until the iframe is mounted + its contentWindow is reachable.
  await vi.waitFor(() => {
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (!el.contentWindow) throw new Error('not mounted yet');
  });
  // The host posts BLOCK_INIT on a retry interval; we just ack READY.
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (el.getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

describe('PageBlockHost REQUEST_CONSENT (W10 lazy-consent wiring)', () => {
  beforeEach(() => {
    // dialogStore is a module-level zustand store shared across tests — reset it.
    useDialogStore.getState().closeAll();
  });

  test('after BLOCK_READY, REQUEST_CONSENT opens the consent dialog with the server-known missing set', async () => {
    const onConsentGranted = vi.fn();
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={onConsentGranted} />);

    await driveToReady();
    expect(useDialogStore.getState().dialogs).toHaveLength(0);

    // The block claims a WIDER set than the host withheld — the host must ignore
    // the claim and grant only its server-known missingScopes.
    postFromBlock('REQUEST_CONSENT', { scopes: ['ai:write:budgeted', 'buzz:spend:self'] });

    await vi.waitFor(() => {
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
    postFromBlock('REQUEST_CONSENT', { scopes: ['ai:write:budgeted'] });

    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
  });
});

describe('PageBlockHost block render/impression (Analytics Phase 2)', () => {
  beforeEach(() => {
    mockBlockRenderMutate.mockClear();
  });

  test('emits track.blockRender exactly once at BLOCK_READY with the page identifiers', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);

    // Not emitted before the handshake completes.
    expect(mockBlockRenderMutate).not.toHaveBeenCalled();

    await driveToReady();

    await vi.waitFor(() => {
      expect(mockBlockRenderMutate).toHaveBeenCalledTimes(1);
    });
    expect(mockBlockRenderMutate).toHaveBeenCalledWith({
      appBlockId: 'apb_test',
      blockInstanceId: 'page_apb_test',
      slotId: 'app.page',
    });
    // No isAnon/userId from the client — those are server-stamped.
    const arg = mockBlockRenderMutate.mock.calls[0][0];
    expect(arg).not.toHaveProperty('isAnon');
    expect(arg).not.toHaveProperty('userId');
  });

  test('does NOT re-emit on a late/duplicate BLOCK_READY (status no longer loading)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);

    await driveToReady();
    await vi.waitFor(() => expect(mockBlockRenderMutate).toHaveBeenCalledTimes(1));

    // A second BLOCK_READY (block re-ack, or a re-render re-running listeners)
    // finds status === 'ready', so the `acked` gate stays false → no re-emit.
    postFromBlock('BLOCK_READY', {});
    postFromBlock('BLOCK_READY', {});
    await new Promise((r) => setTimeout(r, 150));

    expect(mockBlockRenderMutate).toHaveBeenCalledTimes(1);
  });
});
