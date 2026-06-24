import { useState } from 'react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

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

describe('PageBlockHost loading indicator (Task 1)', () => {
  test('shows a loading indicator before BLOCK_READY and removes it once ready', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);

    // While status === 'loading' (iframe mounted, pre-handshake) the centered
    // Loader overlay is present so the surface isn't blank.
    await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();
    await expect.element(page.getByLabelText('Loading Budgeted Generator')).toBeInTheDocument();

    // a11y: the overlay container is marked as a busy live region (role="status"
    // + aria-busy) so a screen reader announces the loading state on the REGION,
    // not just the labeled graphic. Assert the attributes while still loading.
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

  test('the aria-label runs appName through the chrome sanitizer (control/bidi chars stripped)', async () => {
    // A publisher-controlled name carrying a control char (\t) and a bidi
    // override (U+202E) must NOT reach the accessible name verbatim — it goes
    // through the SAME sanitizeAppChromeName the visible chrome uses: the \t
    // control char becomes a space and the U+202E format char is dropped →
    // 'Evil App' (verified against the sanitizer's documented behaviour +
    // appChromeName.test.ts). Built from char codes so the source carries no
    // literal invisible chars.
    const spoofedName = 'Evil' + String.fromCharCode(0x09) + String.fromCharCode(0x202e) + 'App';
    renderWithProviders(
      <PageBlockHost {...baseProps} appName={spoofedName} onConsentGranted={vi.fn()} />
    );
    await expect.element(page.getByLabelText('Loading Evil App')).toBeInTheDocument();
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

  test(
    'loader clears after the BLOCK_READY timeout (timeout terminal path)',
    async () => {
      // token present so the init controller arms its readiness timeout, but we
      // NEVER ack BLOCK_READY → after BLOCK_READY_TIMEOUT_MS (10s) onReadyTimeout
      // flips status 'loading' → 'timeout', clearing the loader and rendering the
      // fallback.
      renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);

      await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();

      // Wait out the real 10s readiness window (poll with generous timeout). The
      // loader must clear and the timeout fallback render.
      await vi.waitFor(
        () => {
          expect(page.getByTestId('app-page-loading').query()).toBeNull();
        },
        { timeout: 13_000, interval: 250 }
      );
      await expect.element(page.getByTestId('app-page-fallback')).toBeInTheDocument();
    },
    20_000
  );

  test(
    'loader clears after the token-wait timeout (no_token terminal path)',
    async () => {
      // token=null and tokenError=false → no init controller (shouldStartInit
      // needs a token) and no synchronous error flip; the token-wait effect's
      // TOKEN_WAIT_TIMEOUT_MS (15s) timer flips status 'loading' → 'no_token',
      // clearing the loader and rendering the fallback. (With a null token the
      // iframe still mounts in the loading state, so the overlay is shown first.)
      renderWithProviders(
        <PageBlockHost {...baseProps} token={null} tokenError={false} onConsentGranted={vi.fn()} />
      );

      await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();

      await vi.waitFor(
        () => {
          expect(page.getByTestId('app-page-loading').query()).toBeNull();
        },
        { timeout: 18_000, interval: 250 }
      );
      await expect.element(page.getByTestId('app-page-fallback')).toBeInTheDocument();
    },
    25_000
  );
});

// Drive the host to the `fatal` terminal state via its REAL status machine:
// reach ready, then post BLOCK_ERROR{fatal:true}. Fast (message-driven), so the
// retry tests don't pay the 10s/15s real-timer windows.
async function driveToFatal() {
  await driveToReady();
  postFromBlock('BLOCK_ERROR', { fatal: true });
  await expect.element(page.getByTestId('app-page-fallback')).toBeInTheDocument();
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
    await expect
      .element(page.getByText('Budgeted Generator failed to load'))
      .toBeInTheDocument();
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

    await expect
      .element(page.getByText("Couldn't authenticate this app"))
      .toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(page.getByTestId('app-page-loading').query()).toBeNull();
  });

  test(
    'timeout terminal state: readable timeout message + Retry, not the loader',
    async () => {
      // token present, never ack BLOCK_READY → readiness timeout (10s) → 'timeout'.
      renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);
      await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();

      await vi.waitFor(
        () => {
          expect(page.getByTestId('app-page-fallback').query()).not.toBeNull();
        },
        { timeout: 13_000, interval: 250 }
      );
      await expect
        .element(page.getByText("This app didn't load in time"))
        .toBeInTheDocument();
      await expect.element(page.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(page.getByTestId('app-page-loading').query()).toBeNull();
    },
    20_000
  );

  test(
    'no_token terminal state: readable auth message + Retry, not the loader',
    async () => {
      // token=null, no error → token-wait timeout (15s) → 'no_token' → token_error copy.
      renderWithProviders(
        <PageBlockHost {...baseProps} token={null} tokenError={false} onConsentGranted={vi.fn()} />
      );
      await expect.element(page.getByTestId('app-page-loading')).toBeInTheDocument();

      await vi.waitFor(
        () => {
          expect(page.getByTestId('app-page-fallback').query()).not.toBeNull();
        },
        { timeout: 18_000, interval: 250 }
      );
      await expect
        .element(page.getByText("Couldn't authenticate this app"))
        .toBeInTheDocument();
      await expect.element(page.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(page.getByTestId('app-page-loading').query()).toBeNull();
    },
    25_000
  );
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
    expect(page.getByTestId('app-page-loading').query()).toBeNull();
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

describe('PageBlockHost block render/impression (Analytics Phase 2)', () => {
  // Analytics Phase 2 now emits via the /api/track/block-render BEACON
  // (sendBlockRender → fetch), not a tRPC mutation. Spy on global fetch and
  // assert the beacon fires exactly once at BLOCK_READY (and never on re-render).
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
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
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
    expect(body).toEqual({
      appBlockId: 'apb_test',
      blockInstanceId: 'page_apb_test',
      slotId: 'app.page',
    });
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
