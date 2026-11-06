import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
import { onReadyAttributeWrite } from '../../../test/commitWindow';

/**
 * W10 money-path bridge gap regression (page surface).
 *
 * A full-page App Block (`/apps/run/<slug>`) that tries to generate
 * (estimate/submit/poll/cancel via the @civitai/blocks-react `useBuzzWorkflow`
 * hook) posts ESTIMATE_WORKFLOW / SUBMIT_WORKFLOW / POLL_WORKFLOW /
 * CANCEL_WORKFLOW. Before this fix the workflow bridge was only wired into the
 * model-slot host (IframeHost); PageBlockHost handled NONE of these → the
 * message fired into the void, no `blocks.*` tRPC call was made, and the SDK
 * request hung to its 120s timeout with NO network call and no error (a live
 * dog-food caught it).
 *
 * The FORWARDING of those messages (and of the buzz / viewer / app-subqueue
 * reads) — call args, every reply shape, no-token and review variants — is
 * pinned row by row in `test/bridgeForwardMatrix.ts`, run against this host by
 * `PageBlockHostForwardMatrix.browser.test.tsx`. What remains here is the one
 * money-path handler that is NOT a plain forward: OPEN_BUZZ_PURCHASE, which
 * opens host chrome (BuyBuzzModal) and is gated on BLOCK_READY.
 *
 * These tests mount the REAL PageBlockHost and drive the actual postMessage
 * bridge. The mutations are mocked via `vi.mock('~/utils/trpc')` (the scaffold's
 * documented pattern) so this stays network-free. We capture the host→block
 * replies by listening on the iframe's contentWindow `message` channel (where
 * `send` posts), mirroring how a real block's transport receives them.
 */

// Per-test-controllable mutation impls. `vi.mock` is hoisted, so the fns must
// live in a hoisted block the factory can close over.
const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  estimate: vi.fn(),
  poll: vi.fn(),
  cancel: vi.fn(),
  balance: vi.fn(),
  transactions: vi.fn(),
  accounts: vi.fn(),
  dailyCompensation: vi.fn(),
  viewer: vi.fn(),
  queryAppWorkflows: vi.fn(),
  cancelAppWorkflow: vi.fn(),
}));

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
    generation: {
      resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      resolveResourceFile: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: mocks.submit }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: mocks.estimate }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: mocks.poll }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: mocks.cancel }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: mocks.balance }) },
      getMyBuzzTransactions: { useMutation: () => ({ mutateAsync: mocks.transactions }) },
      getMyBuzzAccounts: { useMutation: () => ({ mutateAsync: mocks.accounts }) },
      getMyDailyCompensation: { useMutation: () => ({ mutateAsync: mocks.dailyCompensation }) },
      getMyViewer: { useMutation: () => ({ mutateAsync: mocks.viewer }) },
      queryAppWorkflows: { useMutation: () => ({ mutateAsync: mocks.queryAppWorkflows }) },
      cancelAppWorkflow: { useMutation: () => ({ mutateAsync: mocks.cancelAppWorkflow }) },
      publishGenerationOutputs: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      // CREATE_POST_FROM_APP is TWO block-token mutations — the read-only preview
      // that resolves the consent payload, and the write. PageBlockHost reads both
      // at render, so a mock missing either makes the WHOLE component throw and
      // every measurement in the file reads as an empty DOM.
      previewPostFromApp: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      createPostFromApp: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getImagesByIds: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    // PageBlockHost also wires the storage bridge (inert here — exercised in
    // PageBlockHostStorage.browser.test.tsx); stub so the component mounts.
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

// PageBlockHost is imported AFTER the mock is declared (vi.mock is hoisted above
// the import regardless, but keep the order explicit).
// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

// Dispatch a message FROM the host iframe: source = iframe.contentWindow,
// origin = host expectedOrigin (same-origin src). Satisfies both authenticating
// pins usePostMessage enforces. Identical to the consent test's helper.
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

// Capture host→block replies. `send` posts onto the iframe's contentWindow, so
// we listen there. Returns the most recent message of a given type.
function listenForReply() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const iframeEl = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
  const cw = iframeEl.contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  };
  cw.addEventListener('message', handler);
  return {
    received,
    last: (type: string) => [...received].reverse().find((m) => m.type === type),
    stop: () => cw.removeEventListener('message', handler),
  };
}

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
  declaredScopes: ['ai:write:budgeted'],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' },
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

describe('PageBlockHost workflow bridge (W10 money-path wiring)', () => {
  beforeEach(() => {
    mocks.submit.mockReset();
    mocks.estimate.mockReset();
    mocks.poll.mockReset();
    mocks.cancel.mockReset();
    mocks.balance.mockReset();
    mocks.transactions.mockReset();
    mocks.accounts.mockReset();
    mocks.dailyCompensation.mockReset();
    mocks.viewer.mockReset();
    mocks.queryAppWorkflows.mockReset();
    mocks.cancelAppWorkflow.mockReset();
    // dialogStore is a module-level zustand store shared across tests — reset it
    // (the OPEN_BUZZ_PURCHASE handler triggers a dialog on it).
    useDialogStore.getState().closeAll();
  });

  test('OPEN_BUZZ_PURCHASE after BLOCK_READY opens BuyBuzzModal then posts BUZZ_PURCHASE_RESULT', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();
    expect(useDialogStore.getState().dialogs).toHaveLength(0);

    postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: 'rq_buzz', suggestedAmount: 1000 });

    // The host opens the spend modal via the shared dialogStore (same store the
    // model host uses; the modal is a dynamic import that needs a real tRPC
    // provider, so we assert against the store rather than rendering it).
    await vi.waitFor(() => {
      expect(useDialogStore.getState().dialogs).toHaveLength(1);
    });
    const dialog = useDialogStore.getState().dialogs[0];
    const dialogProps = dialog.props as {
      minBuzzAmount?: number;
      attribution?: unknown;
      onPurchaseSuccess: () => void;
    };
    expect(dialogProps.minBuzzAmount).toBe(1000);
    // (c) Page attribution is TRACKED — deriveScopeFromInstanceId('page_apb_test')
    // returns 'viewer_global' (PR #2624), so the host derives the attribution and
    // passes it to the spend modal (the iframe never supplies it).
    expect(dialogProps.attribution).toEqual({
      appId: 'app_test',
      appBlockId: 'apb_test',
      blockInstanceId: 'page_apb_test',
      scope: 'viewer_global',
    });

    // Simulate a successful purchase, then close the modal (BuyBuzzModal's
    // onPurchaseSuccess flips `purchased`; the dialog onClose posts the reply).
    dialogProps.onPurchaseSuccess();
    dialog.options?.onClose?.();

    await vi.waitFor(() => {
      const r = replies.last('BUZZ_PURCHASE_RESULT');
      if (!r) throw new Error('no reply yet');
      // (b) reply carries the matching requestId + { purchased }.
      expect(r.payload).toEqual({ requestId: 'rq_buzz', purchased: true });
      expectReplyKeys('OPEN_BUZZ_PURCHASE', 'success', ['purchased'], r.payload);
    });
    replies.stop();
  });

  test('OPEN_BUZZ_PURCHASE close without a purchase posts purchased:false', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: 'rq_buzz_cancel' });

    await vi.waitFor(() => {
      expect(useDialogStore.getState().dialogs).toHaveLength(1);
    });
    const dialog = useDialogStore.getState().dialogs[0];
    // Close WITHOUT calling onPurchaseSuccess (user dismissed the modal).
    dialog.options?.onClose?.();

    await vi.waitFor(() => {
      const r = replies.last('BUZZ_PURCHASE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_buzz_cancel', purchased: false });
    });
    replies.stop();
  });

  test('OPEN_BUZZ_PURCHASE clamps an over-cap suggestedAmount to BUZZ_PURCHASE_AMOUNT_CAP', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    // 1_000_000 >> the 50_000 cap → the spend modal must be seeded at the cap so
    // a malicious block can't pre-fill an absurd amount.
    postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: 'rq_buzz_cap', suggestedAmount: 1_000_000 });

    await vi.waitFor(() => {
      expect(useDialogStore.getState().dialogs).toHaveLength(1);
    });
    const dialogProps = useDialogStore.getState().dialogs[0].props as { minBuzzAmount?: number };
    expect(dialogProps.minBuzzAmount).toBe(50_000);
  });

  /**
   * REGRESSION GUARD for the host-ready stale-closure race, on the money gate.
   *
   * OPEN_BUZZ_PURCHASE is request/response: the block awaits BUZZ_PURCHASE_RESULT on
   * a promise that rejects only at the SDK's 30s default request timeout
   * (`DEFAULT_REQUEST_TIMEOUT_MS`, @civitai/blocks-react 0.39.0) — so a drop here
   * costs the user's click plus half a minute of nothing.
   *
   * 🔴 The post is driven from `onReadyAttributeWrite`, NOT a MutationObserver — see
   * test/commitWindow.tsx. A MutationObserver callback is a microtask that runs at the
   * END of the scheduler task, often after React has already flushed the passive
   * effects, which made the first version of this guard survive the mutant about one
   * run in three.
   *
   * Proven reachable by mutation: move `statusRef.current = status` out of the render
   * body and back into an effect and this goes red on `expected [] to have a length
   * of 1`.
   */
  test("OPEN_BUZZ_PURCHASE posted in React's commit→passive-effect gap still opens the modal", async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    const unpatch = onReadyAttributeWrite(() =>
      postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: 'rq_gap', suggestedAmount: 1000 })
    );
    try {
      const stopDrive = await startReadyDrive();
      try {
        await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
      } finally {
        stopDrive();
      }
    } finally {
      unpatch();
    }
    // Pin the per-request dialog id, so this proves THIS post opened the modal.
    expect(useDialogStore.getState().dialogs[0].id).toBe('block-buy-buzz-rq_gap');
  });

  /**
   * The gate's REFUSAL is unchanged — no pre-handshake spend modal, ever. What
   * changed is that the refusal is now SPOKEN instead of silent.
   *
   * Previously this branch dropped the message with a bare `return`, leaving the
   * block's promise to hang for the SDK's full 30s request timeout. The reviewMode
   * branch a few
   * lines above in the handler already replied for exactly this reason ("Reply the
   * not-purchased result the block awaits (fail-fast, no hang)"); this branch simply
   * did not, and that asymmetry was the bug.
   *
   * `purchased: false` is the same shape reviewMode sends and the same shape
   * `useBuzzPurchase` reads as "no purchase happened". Nothing is charged.
   */
  test('OPEN_BUZZ_PURCHASE before BLOCK_READY opens no modal and NACKs (never hangs)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    // Do NOT drive to ready — fire while status is still 'loading'.
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
      if (!el.contentWindow) throw new Error('not mounted yet');
    });
    const replies = listenForReply();

    postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: 'rq_buzz_early', suggestedAmount: 1000 });

    await vi.waitFor(() => {
      const r = replies.last('BUZZ_PURCHASE_RESULT');
      if (!r) throw new Error('no NACK yet');
    });
    // THE security property, unchanged: the spend modal never opened.
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    // THE new property: the block was told, on its own requestId, so it fails fast.
    expect(replies.last('BUZZ_PURCHASE_RESULT')!.payload).toEqual({
      requestId: 'rq_buzz_early',
      purchased: false,
    });
    replies.stop();
  });

  /**
   * The OTHER reason `resolveBuzzPurchaseRequest` returns null: a malformed payload
   * with no string requestId. That one is legitimately UNREPLIABLE — there is no id
   * to thread a reply back on — so it must still be dropped in total silence, and
   * the NACK above must not have widened into "reply to everything".
   *
   * POSITIVE CONTROL is load-bearing here: this asserts a ZERO (no modal, no reply),
   * and a host whose listener was never live produces that same zero. The control
   * proves the handler is live AND that a BUZZ_PURCHASE_RESULT is observable at all
   * before the zero is read, so the zero is a measurement rather than an artefact.
   *
   * 🔴 COUNT ONLY `BUZZ_PURCHASE_RESULT`, never `received.length`. The host pushes
   * unrelated messages of its own (BLOCK_INIT, TOKEN_REFRESH, ROUTE_CHANGED) from
   * effects, on a schedule this test does not control — so a TOTAL message count
   * drifts for reasons that have nothing to do with the assertion. Measured: an
   * earlier draft counting `received.length` failed on `expected 1 to be +0`
   * against a host that was behaving perfectly, once the drive handed back inside
   * React's commit window.
   */
  test('OPEN_BUZZ_PURCHASE with NO requestId is dropped silently (nothing to reply to)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();
    const buzzReplies = () => replies.received.filter((m) => m.type === 'BUZZ_PURCHASE_RESULT');

    // POSITIVE CONTROL: a well-formed request DOES get through and open the modal,
    // and closing it DOES produce an observable BUZZ_PURCHASE_RESULT.
    postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: 'rq_control', suggestedAmount: 10 });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    useDialogStore.getState().dialogs[0].options?.onClose?.();
    await vi.waitFor(() => expect(buzzReplies()).toHaveLength(1));
    useDialogStore.getState().closeAll();

    // The real case: no requestId at all.
    postFromBlock('OPEN_BUZZ_PURCHASE', { suggestedAmount: 1000 });

    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    // Still exactly the control's reply — the malformed post added none.
    expect(buzzReplies()).toHaveLength(1);
    replies.stop();
  });
});
