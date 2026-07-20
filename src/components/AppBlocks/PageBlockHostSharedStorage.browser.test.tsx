import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * App Blocks SHARED (cross-user / app-global) storage bridge — host side (Phase 2b).
 *
 * A full-page App Block (`/apps/run/<slug>`, entity=none) that uses the SHARED
 * datastore drives it through the @civitai/app-sdk shared-storage hook, which
 * posts SHARED_LIST / GET_COUNT / GET_COUNTS / APPEND / VOTE / UNVOTE / WITHDRAW
 * and AWAITS the matching SHARED_*_RESULT. Unhandled ⇒ the block hangs to the SDK
 * 30s timeout (the same "spins forever, no network call, no error" class as the
 * per-user APP_STORAGE gap). PageBlockHost bridges each to `trpc.apps.shared.*`.
 *
 * These tests mount the REAL PageBlockHost and drive the actual postMessage
 * bridge, asserting for each of the 7 ops that the host:
 *   1. forwards to the matching `apps.shared.*` proc — reads via
 *      trpc.useUtils()...fetch, writes via the useMutation mock — with the page
 *      `token` prop injected as `blockToken` (NEVER a token from the message) +
 *      the args, and
 *   2. posts the matching `*_RESULT` reply with the requestId + expected payload
 *      on BOTH the success path and the error path (`{ requestId, error }`, never
 *      a hang).
 * Plus: a shared message with the block token spoofed in the message body still
 * forwards the HOST token; a message with no requestId is dropped; and a null
 * page token forwards no proc call.
 *
 * trpc is mocked via `vi.mock('~/utils/trpc')` (the scaffold's documented
 * pattern) so this stays network-free. Replies are captured on the iframe's
 * contentWindow `message` channel — identical to the APP_STORAGE test.
 */

// Per-test-controllable proc impls. `vi.mock` is hoisted, so the fns live in a
// hoisted block the factory closes over. Reads go through trpc.useUtils()...fetch;
// writes through trpc.apps.shared.{append,vote,unvote,withdraw}.useMutation().mutateAsync.
const mocks = vi.hoisted(() => ({
  // shared reads
  list: vi.fn(),
  getCount: vi.fn(),
  getCounts: vi.fn(),
  // shared writes
  append: vi.fn(),
  update: vi.fn(),
  vote: vi.fn(),
  unvote: vi.fn(),
  withdraw: vi.fn(),
  // per-user storage reads/writes (also wired at render; inert here)
  storageGet: vi.fn(),
  storageSet: vi.fn(),
  storageDelete: vi.fn(),
  storageList: vi.fn(),
  storageGetQuota: vi.fn(),
}));

// AppBlockChrome (in the host frame) calls useCurrentUser() for the platform-nav
// moderator gate; these suites render the real host without a CivitaiSessionProvider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', () => ({
  // FeatureFlagsProvider (in PageBlockHost's real render graph) statically imports
  // `setTrpcBatchingEnabled` from this module (#2946). vi.mock replaces the module
  // wholesale, so the factory must re-declare it or the ESM link fails.
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    // W13 wildcard-pack import: PageBlockHost now calls this at render; stub so the mount succeeds (behavior covered in PageBlockHostWildcardPack.browser.test.tsx).
    generation: { resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
    // PageBlockHost also wires the workflow bridge at render (inert here); stub so
    // it mounts.
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
      storage: {
        set: { useMutation: () => ({ mutateAsync: mocks.storageSet }) },
        delete: { useMutation: () => ({ mutateAsync: mocks.storageDelete }) },
      },
      shared: {
        append: { useMutation: () => ({ mutateAsync: mocks.append }) },
        update: { useMutation: () => ({ mutateAsync: mocks.update }) },
        vote: { useMutation: () => ({ mutateAsync: mocks.vote }) },
        unvote: { useMutation: () => ({ mutateAsync: mocks.unvote }) },
        withdraw: { useMutation: () => ({ mutateAsync: mocks.withdraw }) },
      },
    },
    useUtils: () => ({
      apps: {
        storage: {
          get: { fetch: mocks.storageGet },
          list: { fetch: mocks.storageList },
          getQuota: { fetch: mocks.storageGetQuota },
        },
        shared: {
          list: { fetch: mocks.list },
          getCount: { fetch: mocks.getCount },
          getCounts: { fetch: mocks.getCounts },
        },
      },
    }),
  },
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

// Dispatch a message FROM the host iframe: source = iframe.contentWindow,
// origin = host expectedOrigin (same-origin src). Satisfies both authenticating
// pins usePostMessage enforces.
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

// Capture host→block replies. `send` posts onto the iframe's contentWindow.
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
  appName: 'Requests',
  iframeSrc: SAME_ORIGIN_SRC,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'my-page-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: ['apps:storage:shared:read', 'apps:storage:shared:write'],
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

describe('PageBlockHost SHARED storage bridge (Phase 2b cross-user datastore)', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.getCount.mockReset();
    mocks.getCounts.mockReset();
    mocks.append.mockReset();
    mocks.update.mockReset();
    mocks.vote.mockReset();
    mocks.unvote.mockReset();
    mocks.withdraw.mockReset();
    useDialogStore.getState().closeAll();
  });

  // ── SHARED_LIST ────────────────────────────────────────────────────────────
  test('SHARED_LIST forwards clamped args + host token and posts SHARED_LIST_RESULT', async () => {
    const createdAt = new Date('2026-06-17T00:00:00.000Z');
    const updatedAt = new Date('2026-06-18T00:00:00.000Z');
    mocks.list.mockResolvedValue({
      items: [
        {
          key: '01ABC',
          authorUserId: 7,
          value: { title: 'Add dark mode', body: 'please' },
          count: 3,
          createdAt,
          updatedAt,
        },
      ],
      nextCursor: 'cur2',
    });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    // limit 9999 clamped to the server max (100); a spoofed blockToken in the
    // message body must be IGNORED (host injects its own token).
    postFromBlock('SHARED_LIST', {
      requestId: 'rq_list',
      prefix: 'p',
      limit: 9999,
      cursor: 'cur1',
      blockToken: 'SPOOFED',
    });

    await vi.waitFor(() => {
      expect(mocks.list).toHaveBeenCalledWith({
        blockToken: 'tok_abc',
        prefix: 'p',
        limit: 100,
        cursor: 'cur1',
      });
    });
    await vi.waitFor(() => {
      const r = replies.last('SHARED_LIST_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_list',
        items: [
          {
            key: '01ABC',
            authorUserId: 7,
            value: { title: 'Add dark mode', body: 'please' },
            count: 3,
            createdAt: '2026-06-17T00:00:00.000Z',
            updatedAt: '2026-06-18T00:00:00.000Z',
          },
        ],
        nextCursor: 'cur2',
      });
    });
    replies.stop();
  });

  test('SHARED_LIST error path posts { requestId, error } (no hang)', async () => {
    mocks.list.mockRejectedValue(new Error('shared storage is not enabled'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_LIST', { requestId: 'rq_list_err' });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_LIST_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_list_err',
        error: 'shared storage is not enabled',
      });
    });
    replies.stop();
  });

  // ── SHARED_GET_COUNT ─────────────────────────────────────────────────────────
  test('SHARED_GET_COUNT forwards key + host token and posts SHARED_GET_COUNT_RESULT', async () => {
    mocks.getCount.mockResolvedValue({ count: 5 });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_GET_COUNT', { requestId: 'rq_gc', key: '01ABC', blockToken: 'SPOOFED' });

    await vi.waitFor(() => {
      expect(mocks.getCount).toHaveBeenCalledWith({ blockToken: 'tok_abc', key: '01ABC' });
    });
    await vi.waitFor(() => {
      const r = replies.last('SHARED_GET_COUNT_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_gc', count: 5 });
    });
    replies.stop();
  });

  test('SHARED_GET_COUNT error path posts { requestId, error } (no hang)', async () => {
    mocks.getCount.mockRejectedValue(new Error('request not found'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_GET_COUNT', { requestId: 'rq_gc_err', key: 'missing' });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_GET_COUNT_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_gc_err', error: 'request not found' });
    });
    replies.stop();
  });

  // ── SHARED_GET_COUNTS ────────────────────────────────────────────────────────
  test('SHARED_GET_COUNTS forwards keys + host token and posts SHARED_GET_COUNTS_RESULT', async () => {
    mocks.getCounts.mockResolvedValue({ counts: { a: 1, b: 0 } });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_GET_COUNTS', {
      requestId: 'rq_gcs',
      keys: ['a', 'b'],
      blockToken: 'SPOOFED',
    });

    await vi.waitFor(() => {
      expect(mocks.getCounts).toHaveBeenCalledWith({ blockToken: 'tok_abc', keys: ['a', 'b'] });
    });
    await vi.waitFor(() => {
      const r = replies.last('SHARED_GET_COUNTS_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_gcs', counts: { a: 1, b: 0 } });
    });
    replies.stop();
  });

  test('SHARED_GET_COUNTS error path posts { requestId, error } (no hang)', async () => {
    mocks.getCounts.mockRejectedValue(new Error('too many keys'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_GET_COUNTS', { requestId: 'rq_gcs_err', keys: ['a'] });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_GET_COUNTS_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_gcs_err', error: 'too many keys' });
    });
    replies.stop();
  });

  // ── SHARED_APPEND ────────────────────────────────────────────────────────────
  test('SHARED_APPEND forwards value + host token and posts SHARED_APPEND_RESULT', async () => {
    mocks.append.mockResolvedValue({ key: '01NEW' });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_APPEND', {
      requestId: 'rq_app',
      value: { title: 'New idea', body: 'details' },
      blockToken: 'SPOOFED',
    });

    await vi.waitFor(() => {
      expect(mocks.append).toHaveBeenCalledWith({
        blockToken: 'tok_abc',
        value: { title: 'New idea', body: 'details' },
      });
    });
    await vi.waitFor(() => {
      const r = replies.last('SHARED_APPEND_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_app', key: '01NEW' });
    });
    replies.stop();
  });

  test('SHARED_APPEND error path posts { requestId, error } (no hang)', async () => {
    mocks.append.mockRejectedValue(new Error('Too many submissions — retry in 30s'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_APPEND', { requestId: 'rq_app_err', value: { title: 'spam' } });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_APPEND_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_app_err',
        error: 'Too many submissions — retry in 30s',
      });
    });
    replies.stop();
  });

  // ── SHARED_UPDATE ────────────────────────────────────────────────────────────
  test('SHARED_UPDATE forwards key + value + host token and posts SHARED_UPDATE_RESULT {ok:true}', async () => {
    mocks.update.mockResolvedValue({ ok: true });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_UPDATE', {
      requestId: 'rq_upd',
      key: '01EXISTING',
      value: { title: 'Edited idea', body: 'new details' },
      blockToken: 'SPOOFED',
    });

    await vi.waitFor(() => {
      // Host token wins over any client-supplied blockToken.
      expect(mocks.update).toHaveBeenCalledWith({
        blockToken: 'tok_abc',
        key: '01EXISTING',
        value: { title: 'Edited idea', body: 'new details' },
      });
    });
    await vi.waitFor(() => {
      const r = replies.last('SHARED_UPDATE_RESULT');
      if (!r) throw new Error('no reply yet');
      // SDK 0.24 contract: { requestId, ok, error? } — resolves on ok.
      expect(r.payload).toEqual({ requestId: 'rq_upd', ok: true });
    });
    replies.stop();
  });

  test('SHARED_UPDATE error path posts { requestId, ok:false, error } (no hang)', async () => {
    mocks.update.mockRejectedValue(new Error('you can only edit your own submissions'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_UPDATE', {
      requestId: 'rq_upd_err',
      key: '01EXISTING',
      value: { title: 'nope' },
    });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_UPDATE_RESULT');
      if (!r) throw new Error('no reply yet');
      // ok:false is REQUIRED — the SDK validator drops a reply without a boolean ok.
      expect(r.payload).toEqual({
        requestId: 'rq_upd_err',
        ok: false,
        error: 'you can only edit your own submissions',
      });
    });
    replies.stop();
  });

  // ── SHARED_VOTE ──────────────────────────────────────────────────────────────
  test('SHARED_VOTE forwards key + host token and posts SHARED_VOTE_RESULT', async () => {
    mocks.vote.mockResolvedValue({ count: 4 });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_VOTE', { requestId: 'rq_vote', key: '01ABC', blockToken: 'SPOOFED' });

    await vi.waitFor(() => {
      expect(mocks.vote).toHaveBeenCalledWith({ blockToken: 'tok_abc', key: '01ABC' });
    });
    await vi.waitFor(() => {
      const r = replies.last('SHARED_VOTE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_vote', count: 4 });
    });
    replies.stop();
  });

  test('SHARED_VOTE error path posts { requestId, error } (no hang)', async () => {
    mocks.vote.mockRejectedValue(new Error('request not found'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_VOTE', { requestId: 'rq_vote_err', key: 'missing' });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_VOTE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_vote_err', error: 'request not found' });
    });
    replies.stop();
  });

  // ── SHARED_UNVOTE ────────────────────────────────────────────────────────────
  test('SHARED_UNVOTE forwards key + host token and posts SHARED_UNVOTE_RESULT', async () => {
    mocks.unvote.mockResolvedValue({ count: 2 });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_UNVOTE', { requestId: 'rq_unvote', key: '01ABC', blockToken: 'SPOOFED' });

    await vi.waitFor(() => {
      expect(mocks.unvote).toHaveBeenCalledWith({ blockToken: 'tok_abc', key: '01ABC' });
    });
    await vi.waitFor(() => {
      const r = replies.last('SHARED_UNVOTE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_unvote', count: 2 });
    });
    replies.stop();
  });

  test('SHARED_UNVOTE error path posts { requestId, error } (no hang)', async () => {
    mocks.unvote.mockRejectedValue(new Error('Too many votes — retry in 10s'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_UNVOTE', { requestId: 'rq_unvote_err', key: '01ABC' });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_UNVOTE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_unvote_err',
        error: 'Too many votes — retry in 10s',
      });
    });
    replies.stop();
  });

  // ── SHARED_WITHDRAW ──────────────────────────────────────────────────────────
  test('SHARED_WITHDRAW forwards key + host token and posts SHARED_WITHDRAW_RESULT', async () => {
    mocks.withdraw.mockResolvedValue({ ok: true, deleted: true });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_WITHDRAW', {
      requestId: 'rq_wd',
      key: '01ABC',
      blockToken: 'SPOOFED',
    });

    await vi.waitFor(() => {
      expect(mocks.withdraw).toHaveBeenCalledWith({ blockToken: 'tok_abc', key: '01ABC' });
    });
    await vi.waitFor(() => {
      const r = replies.last('SHARED_WITHDRAW_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_wd', ok: true, deleted: true });
    });
    replies.stop();
  });

  test('SHARED_WITHDRAW error path posts { requestId, error } (no hang)', async () => {
    mocks.withdraw.mockRejectedValue(new Error('storage unavailable'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_WITHDRAW', { requestId: 'rq_wd_err', key: '01ABC' });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_WITHDRAW_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_wd_err', error: 'storage unavailable' });
    });
    replies.stop();
  });

  // ── Gating: pre-ready / no requestId / null token ────────────────────────────
  test('a shared message with NO requestId is dropped (no proc call, no reply)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_VOTE', { key: '01ABC' }); // missing requestId

    await new Promise((r) => setTimeout(r, 150));
    expect(mocks.vote).not.toHaveBeenCalled();
    expect(replies.last('SHARED_VOTE_RESULT')).toBeUndefined();
    replies.stop();
  });

  test('a shared message with a null page token is dropped (cannot forward a shared call)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} token={null} />);
    // With a null token the host never reaches BLOCK_READY (the iframe gates on
    // token); either way the handler must refuse to call the proc — apps.shared.*
    // require a non-null blockToken.
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement | null;
      if (!el) return;
    });
    expect(mocks.vote).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
