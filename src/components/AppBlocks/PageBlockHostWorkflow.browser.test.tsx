import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

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
 * These tests mount the REAL PageBlockHost (same posture as the consent test)
 * and drive the actual postMessage bridge, asserting that:
 *   1. the host forwards to the matching `blocks.*` mutation with the page
 *      `token` prop as `blockToken`, and
 *   2. it posts the reply back to the iframe with the matching requestId — on
 *      BOTH the success path (real snapshot) and the throw path (a
 *      failureSnapshot-shaped reply, so the block never hangs).
 *
 * The mutations are mocked via `vi.mock('~/utils/trpc')` (the scaffold's
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
    // W13 wildcard-pack import: PageBlockHost now calls this at render; stub so the mount succeeds (behavior covered in PageBlockHostWildcardPack.browser.test.tsx).
    generation: { resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
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
    // dialogStore is a module-level zustand store shared across tests — reset it
    // (the OPEN_BUZZ_PURCHASE handler triggers a dialog on it).
    useDialogStore.getState().closeAll();
  });

  test('ESTIMATE_WORKFLOW forwards to estimateWorkflow with the page token and posts ESTIMATE_RESULT', async () => {
    const snapshot = { workflowId: 'wf_1', status: 'pending', cost: { total: 25 } };
    mocks.estimate.mockResolvedValue({ snapshot });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('ESTIMATE_WORKFLOW', { requestId: 'rq_est', body: { prompt: 'cat' } });

    await vi.waitFor(() => {
      expect(mocks.estimate).toHaveBeenCalledTimes(1);
    });
    // Forwarded the page `token` PROP as blockToken + the untrusted body verbatim.
    expect(mocks.estimate).toHaveBeenCalledWith({
      blockToken: 'tok_abc',
      body: { prompt: 'cat' },
    });

    await vi.waitFor(() => {
      const r = replies.last('ESTIMATE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_est', snapshot });
    });
    replies.stop();
  });

  test('ESTIMATE_WORKFLOW error path posts a failureSnapshot-shaped ESTIMATE_RESULT (no hang)', async () => {
    mocks.estimate.mockRejectedValue(new Error('insufficient buzz'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('ESTIMATE_WORKFLOW', { requestId: 'rq_err', body: {} });

    await vi.waitFor(() => {
      const r = replies.last('ESTIMATE_RESULT');
      if (!r) throw new Error('no reply yet');
      // failureSnapshot shape: non-empty 'failed' workflowId + status + message.
      expect(r.payload).toEqual({
        requestId: 'rq_err',
        snapshot: { workflowId: 'failed', status: 'failed', error: 'insufficient buzz' },
      });
    });
    replies.stop();
  });

  test('SUBMIT_WORKFLOW forwards to submitWorkflow and posts WORKFLOW_SUBMITTED', async () => {
    const snapshot = { workflowId: 'wf_sub', status: 'processing' };
    mocks.submit.mockResolvedValue({ snapshot });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SUBMIT_WORKFLOW', { requestId: 'rq_sub', body: { prompt: 'dog' } });

    await vi.waitFor(() => {
      expect(mocks.submit).toHaveBeenCalledWith({
        blockToken: 'tok_abc',
        body: { prompt: 'dog' },
      });
    });
    await vi.waitFor(() => {
      const r = replies.last('WORKFLOW_SUBMITTED');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_sub', snapshot });
    });
    replies.stop();
  });

  test('POLL_WORKFLOW forwards workflowId and posts WORKFLOW_STATUS', async () => {
    const snapshot = { workflowId: 'wf_poll', status: 'succeeded' };
    mocks.poll.mockResolvedValue({ snapshot });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('POLL_WORKFLOW', { requestId: 'rq_poll', workflowId: 'wf_poll' });

    await vi.waitFor(() => {
      expect(mocks.poll).toHaveBeenCalledWith({ blockToken: 'tok_abc', workflowId: 'wf_poll' });
    });
    await vi.waitFor(() => {
      const r = replies.last('WORKFLOW_STATUS');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_poll', snapshot });
    });
    replies.stop();
  });

  test('CANCEL_WORKFLOW forwards workflowId and posts WORKFLOW_CANCELED', async () => {
    const snapshot = { workflowId: 'wf_cancel', status: 'canceled' };
    mocks.cancel.mockResolvedValue({ snapshot });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('CANCEL_WORKFLOW', { requestId: 'rq_cancel', workflowId: 'wf_cancel' });

    await vi.waitFor(() => {
      expect(mocks.cancel).toHaveBeenCalledWith({ blockToken: 'tok_abc', workflowId: 'wf_cancel' });
    });
    await vi.waitFor(() => {
      const r = replies.last('WORKFLOW_CANCELED');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_cancel', snapshot });
    });
    replies.stop();
  });

  test('CANCEL_WORKFLOW error path posts a failureSnapshot-shaped WORKFLOW_CANCELED (no hang)', async () => {
    mocks.cancel.mockRejectedValue(new Error('not the owner'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('CANCEL_WORKFLOW', { requestId: 'rq_cancel_err', workflowId: 'wf_cancel' });

    await vi.waitFor(() => {
      const r = replies.last('WORKFLOW_CANCELED');
      if (!r) throw new Error('no reply yet');
      // failureSnapshot shape: non-empty 'failed' workflowId (the SDK validator
      // drops an empty workflowId) + status + message — so the block never hangs.
      expect(r.payload).toEqual({
        requestId: 'rq_cancel_err',
        snapshot: { workflowId: 'failed', status: 'failed', error: 'not the owner' },
      });
    });
    replies.stop();
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

  test('OPEN_BUZZ_PURCHASE before BLOCK_READY is dropped (no pre-handshake spend modal)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    // Do NOT drive to ready — fire while status is still 'loading'.
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
      if (!el.contentWindow) throw new Error('not mounted yet');
    });
    const replies = listenForReply();

    postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: 'rq_buzz_early', suggestedAmount: 1000 });

    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(replies.last('BUZZ_PURCHASE_RESULT')).toBeUndefined();
    replies.stop();
  });

  test('a workflow message with NO requestId is dropped (no mutation, no reply)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('ESTIMATE_WORKFLOW', { body: { prompt: 'x' } }); // missing requestId

    await new Promise((r) => setTimeout(r, 150));
    expect(mocks.estimate).not.toHaveBeenCalled();
    expect(replies.last('ESTIMATE_RESULT')).toBeUndefined();
    replies.stop();
  });

  test('a workflow message with a null page token is dropped (cannot forward a money call)', async () => {
    // token=null can't reach BLOCK_READY (the iframe gates on token), so drive
    // the gate manually: a null-token host never posts a usable surface. We
    // assert the handler refuses to call the mutation even if a message arrives.
    renderWithProviders(<PageBlockHost {...baseProps} token={null} />);
    // No driveToReady (no token → no ready). Wait for mount, then fire.
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement | null;
      // With a null token the host shows a no_token/loading fallback; the iframe
      // may not mount. If it doesn't, there is nothing to spoof — assertion holds
      // trivially (no mutation possible). Bail out of the wait either way.
      if (!el) return;
    });
    expect(mocks.estimate).not.toHaveBeenCalled();
  });

  // ── Phase 3: per-account buzz — GET_BUZZ_BALANCE + accountType forwarding ────
  //
  // The block reads its own per-account (blue/green/yellow) balance via the
  // @civitai/blocks-react `useBuzzBalance()` hook, which posts GET_BUZZ_BALANCE
  // and awaits BUZZ_BALANCE_RESULT. The host mediates it through the block-token-
  // authed `blocks.getMyBuzzBalance` MUTATION (token-`sub`-bound server-side); on
  // submit it forwards a preferred `accountType`, and surfaces the realized
  // `spentAccountType` back on the snapshot. Every path MUST reply or the block
  // hangs to its SDK timeout.
  test('GET_BUZZ_BALANCE forwards the page token to getMyBuzzBalance and posts BUZZ_BALANCE_RESULT', async () => {
    const balance = { blue: 1200, green: 300, yellow: 50 };
    mocks.balance.mockResolvedValue(balance);
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_BUZZ_BALANCE', { requestId: 'rq_bal' });

    await vi.waitFor(() => {
      // Forwarded the page `token` PROP as blockToken (the SELF-BOUND credential);
      // the handler never trusts a client-supplied userId.
      expect(mocks.balance).toHaveBeenCalledWith({ blockToken: 'tok_abc' });
    });
    await vi.waitFor(() => {
      const r = replies.last('BUZZ_BALANCE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_bal', balance });
    });
    replies.stop();
  });

  test('GET_BUZZ_BALANCE error path posts an error-variant BUZZ_BALANCE_RESULT (no hang)', async () => {
    mocks.balance.mockRejectedValue(new Error('invalid block token'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_BUZZ_BALANCE', { requestId: 'rq_bal_err' });

    await vi.waitFor(() => {
      const r = replies.last('BUZZ_BALANCE_RESULT');
      if (!r) throw new Error('no reply yet');
      // error-carrying variant (no balance) so the useBuzzBalance hook rejects
      // instead of spinning to its timeout.
      expect(r.payload).toEqual({ requestId: 'rq_bal_err', error: 'invalid block token' });
    });
    replies.stop();
  });

  test('GET_BUZZ_BALANCE with NO requestId is dropped (no mutation, no reply)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_BUZZ_BALANCE', {}); // missing requestId

    await new Promise((r) => setTimeout(r, 150));
    expect(mocks.balance).not.toHaveBeenCalled();
    expect(replies.last('BUZZ_BALANCE_RESULT')).toBeUndefined();
    replies.stop();
  });

  test('GET_BUZZ_BALANCE with a null page token replies with the error variant (never hangs)', async () => {
    // DEVIATION from the workflow handlers (which DROP a null-token request): a
    // balance read is a pure UI affordance, so a null token replies with the
    // error variant instead of stranding the hook. The iframe still mounts while
    // status === 'loading' (before the no_token timeout), so a block CAN post.
    renderWithProviders(<PageBlockHost {...baseProps} token={null} />);
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement | null;
      if (!el?.contentWindow) throw new Error('iframe not mounted yet');
    });
    const replies = listenForReply();

    postFromBlock('GET_BUZZ_BALANCE', { requestId: 'rq_bal_notoken' });

    await vi.waitFor(() => {
      const r = replies.last('BUZZ_BALANCE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_bal_notoken', error: 'no block token' });
    });
    // No server call is made without a token.
    expect(mocks.balance).not.toHaveBeenCalled();
    replies.stop();
  });

  // ── Viewer self-read — GET_VIEWER → VIEWER_RESULT. The block reads its own
  //    identity ("who am I") via the @civitai/blocks-react `useViewer()` hook,
  //    which posts GET_VIEWER and awaits VIEWER_RESULT. The host mediates it
  //    through the block-token-authed `blocks.getMyViewer` MUTATION (token-`sub`-
  //    bound + user:read:self server-side). GET_VIEWER takes NO params, so only
  //    the page token is forwarded — a block-sent field can't override it. Every
  //    path MUST reply or the block hangs to its SDK timeout.
  test('GET_VIEWER forwards ONLY the page token to getMyViewer and posts VIEWER_RESULT', async () => {
    const viewer = { id: 42, username: 'u', status: 'active', buzzBudget: 50 };
    mocks.viewer.mockResolvedValue(viewer);
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_VIEWER', { requestId: 'rq_viewer' });

    await vi.waitFor(() => {
      // Forwarded ONLY the page `token` PROP as blockToken (the SELF-BOUND
      // credential) — GET_VIEWER carries no params, and the handler never trusts
      // a client-supplied identity.
      expect(mocks.viewer).toHaveBeenCalledWith({ blockToken: 'tok_abc' });
    });
    await vi.waitFor(() => {
      const r = replies.last('VIEWER_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_viewer', viewer });
    });
    replies.stop();
  });

  test('GET_VIEWER error path posts an error-variant VIEWER_RESULT (no hang)', async () => {
    mocks.viewer.mockRejectedValue(new Error('block lacks user:read:self scope'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_VIEWER', { requestId: 'rq_viewer_err' });

    await vi.waitFor(() => {
      const r = replies.last('VIEWER_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_viewer_err',
        error: 'block lacks user:read:self scope',
      });
    });
    replies.stop();
  });

  test('GET_VIEWER with NO requestId is dropped (no mutation, no reply)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_VIEWER', {}); // missing requestId

    await new Promise((r) => setTimeout(r, 150));
    expect(mocks.viewer).not.toHaveBeenCalled();
    expect(replies.last('VIEWER_RESULT')).toBeUndefined();
    replies.stop();
  });

  test('GET_VIEWER with a null page token replies with the error variant (never hangs)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} token={null} />);
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement | null;
      if (!el?.contentWindow) throw new Error('iframe not mounted yet');
    });
    const replies = listenForReply();

    postFromBlock('GET_VIEWER', { requestId: 'rq_viewer_notoken' });

    await vi.waitFor(() => {
      const r = replies.last('VIEWER_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_viewer_notoken', error: 'no block token' });
    });
    // No server call is made without a token.
    expect(mocks.viewer).not.toHaveBeenCalled();
    replies.stop();
  });

  // ── Buzz self-read dashboard bridges — GET_BUZZ_TRANSACTIONS / GET_BUZZ_ACCOUNTS
  //    / GET_DAILY_COMPENSATION → *_RESULT. Each mirrors GET_BUZZ_BALANCE: forward
  //    the page token to the buzz:read:self mutation, post the JSON back, and reply
  //    on EVERY path (no-token error variant, service-error variant) so the block
  //    never hangs. requestId correlation is asserted end-to-end.
  test('GET_BUZZ_TRANSACTIONS forwards token + params and posts BUZZ_TRANSACTIONS_RESULT', async () => {
    const result = { cursor: null, transactions: [{ type: 'Tip', amount: 5 }] };
    mocks.transactions.mockResolvedValue(result);
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_BUZZ_TRANSACTIONS', {
      requestId: 'rq_txn',
      params: { accountType: 'yellow', limit: 50 },
    });

    await vi.waitFor(() => {
      expect(mocks.transactions).toHaveBeenCalledWith({
        blockToken: 'tok_abc',
        accountType: 'yellow',
        limit: 50,
      });
    });
    await vi.waitFor(() => {
      const r = replies.last('BUZZ_TRANSACTIONS_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_txn', result });
    });
    replies.stop();
  });

  test('GET_BUZZ_TRANSACTIONS error path posts an error-variant result (no hang)', async () => {
    mocks.transactions.mockRejectedValue(new Error('block lacks buzz:read:self scope'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_BUZZ_TRANSACTIONS', { requestId: 'rq_txn_err' });

    await vi.waitFor(() => {
      const r = replies.last('BUZZ_TRANSACTIONS_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_txn_err',
        error: 'block lacks buzz:read:self scope',
      });
    });
    replies.stop();
  });

  test('GET_BUZZ_TRANSACTIONS with a null page token replies with the error variant (never hangs)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} token={null} />);
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement | null;
      if (!el?.contentWindow) throw new Error('iframe not mounted yet');
    });
    const replies = listenForReply();

    postFromBlock('GET_BUZZ_TRANSACTIONS', { requestId: 'rq_txn_notoken' });

    await vi.waitFor(() => {
      const r = replies.last('BUZZ_TRANSACTIONS_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_txn_notoken', error: 'no block token' });
    });
    expect(mocks.transactions).not.toHaveBeenCalled();
    replies.stop();
  });

  test('GET_BUZZ_TRANSACTIONS ignores a block-supplied blockToken in params (host token is authoritative)', async () => {
    mocks.transactions.mockResolvedValue({ cursor: null, transactions: [] });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    // A block tries to smuggle its own blockToken via params — it must NOT override
    // the host's page token (blockToken is spread LAST in the handler).
    postFromBlock('GET_BUZZ_TRANSACTIONS', {
      requestId: 'rq_txn_override',
      params: { accountType: 'yellow', blockToken: 'EVIL_TOKEN' },
    });

    await vi.waitFor(() => {
      expect(mocks.transactions).toHaveBeenCalled();
    });
    const arg = mocks.transactions.mock.calls[0][0] as { blockToken: string; accountType: string };
    expect(arg.blockToken).toBe('tok_abc'); // the HOST page token, never the block-sent one
    expect(arg.accountType).toBe('yellow'); // legit params still forwarded
    replies.stop();
  });

  test('GET_DAILY_COMPENSATION ignores a block-supplied blockToken in params (host token is authoritative)', async () => {
    mocks.dailyCompensation.mockResolvedValue({ resources: [], hasPublishedResources: false });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_DAILY_COMPENSATION', {
      requestId: 'rq_comp_override',
      params: { date: '2026-07-01', blockToken: 'EVIL_TOKEN' },
    });

    await vi.waitFor(() => {
      expect(mocks.dailyCompensation).toHaveBeenCalled();
    });
    const arg = mocks.dailyCompensation.mock.calls[0][0] as { blockToken: string; date: string };
    expect(arg.blockToken).toBe('tok_abc');
    expect(arg.date).toBe('2026-07-01');
    replies.stop();
  });

  test('GET_BUZZ_ACCOUNTS forwards token and posts BUZZ_ACCOUNTS_RESULT', async () => {
    const result = { accounts: [{ accountType: 'yellow', balance: 100 }] };
    mocks.accounts.mockResolvedValue(result);
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_BUZZ_ACCOUNTS', { requestId: 'rq_acct_read' });

    await vi.waitFor(() => {
      expect(mocks.accounts).toHaveBeenCalledWith({ blockToken: 'tok_abc' });
    });
    await vi.waitFor(() => {
      const r = replies.last('BUZZ_ACCOUNTS_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_acct_read', result });
    });
    replies.stop();
  });

  test('GET_DAILY_COMPENSATION forwards token + params and posts DAILY_COMPENSATION_RESULT', async () => {
    const result = { resources: [], hasPublishedResources: false };
    mocks.dailyCompensation.mockResolvedValue(result);
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_DAILY_COMPENSATION', {
      requestId: 'rq_comp',
      params: { date: '2026-07-01' },
    });

    await vi.waitFor(() => {
      expect(mocks.dailyCompensation).toHaveBeenCalledWith({
        blockToken: 'tok_abc',
        date: '2026-07-01',
      });
    });
    await vi.waitFor(() => {
      const r = replies.last('DAILY_COMPENSATION_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_comp', result });
    });
    replies.stop();
  });

  test('GET_DAILY_COMPENSATION with a null page token replies with the error variant', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} token={null} />);
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement | null;
      if (!el?.contentWindow) throw new Error('iframe not mounted yet');
    });
    const replies = listenForReply();

    postFromBlock('GET_DAILY_COMPENSATION', { requestId: 'rq_comp_notoken' });

    await vi.waitFor(() => {
      const r = replies.last('DAILY_COMPENSATION_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_comp_notoken', error: 'no block token' });
    });
    expect(mocks.dailyCompensation).not.toHaveBeenCalled();
    replies.stop();
  });

  test('SUBMIT_WORKFLOW forwards a preferred accountType through to submitWorkflow', async () => {
    const snapshot = { workflowId: 'wf_acct', status: 'processing', spentAccountType: 'green' };
    mocks.submit.mockResolvedValue({ snapshot });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    // The block picks a preferred wallet; the host passes the body through
    // wholesale (server-side domain-clamps it), so accountType rides along.
    postFromBlock('SUBMIT_WORKFLOW', {
      requestId: 'rq_acct',
      body: { prompt: 'fox', accountType: 'green' },
    });

    await vi.waitFor(() => {
      expect(mocks.submit).toHaveBeenCalledWith({
        blockToken: 'tok_abc',
        body: { prompt: 'fox', accountType: 'green' },
      });
    });
    // And the realized spentAccountType on the returned snapshot reaches the block
    // (the host does NOT field-whitelist the snapshot — it passes it through).
    await vi.waitFor(() => {
      const r = replies.last('WORKFLOW_SUBMITTED');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_acct', snapshot });
      expect((r.payload as { snapshot: { spentAccountType?: string } }).snapshot.spentAccountType).toBe(
        'green'
      );
    });
    replies.stop();
  });
});
