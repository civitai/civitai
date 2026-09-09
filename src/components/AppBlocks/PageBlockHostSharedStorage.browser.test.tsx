import { describe, expect, test, vi, beforeEach } from 'vitest';
import { BLOCK_STORAGE_READ_STALE_TIME_MS } from '~/components/AppBlocks/blockStorageCache';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { SAVE_IMAGE_MAX_CONCURRENT } from '~/components/AppBlocks/saveImageDownload';

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
  get: vi.fn(),
  getCount: vi.fn(),
  getCounts: vi.fn(),
  // shared read-cache invalidation (apps.shared namespace-level)
  invalidate: vi.fn(),
  // shared writes
  append: vi.fn(),
  update: vi.fn(),
  vote: vi.fn(),
  unvote: vi.fn(),
  withdraw: vi.fn(),
  report: vi.fn(),
  // gated cross-user image read (backs the SAVE_IMAGE id variant)
  getImagesByIds: vi.fn(),
  // the top-frame blob download (stubbed so no real network fetch in the test);
  // the origin allowlist + request parse stay REAL (see the partial mock below).
  saveDownload: vi.fn(),
  // per-user storage reads/writes (also wired at render; inert here)
  storageGet: vi.fn(),
  storageSet: vi.fn(),
  storageDelete: vi.fn(),
  storageList: vi.fn(),
  storageGetQuota: vi.fn(),
  storageInvalidate: vi.fn(),
}));

// AppBlockChrome (in the host frame) calls useCurrentUser() for the platform-nav
// moderator gate; these suites render the real host without a CivitaiSessionProvider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// Partial mock: keep the REAL origin allowlist + filename sanitizer + request
// parser (the security-critical pure logic), stub ONLY the top-frame blob
// download so the SAVE_IMAGE tests never hit the network.
vi.mock('~/components/AppBlocks/saveImageDownload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./saveImageDownload')>();
  return { ...actual, downloadUrlAsBlob: mocks.saveDownload };
});

vi.mock('~/utils/trpc', () => ({
  // FeatureFlagsProvider (in PageBlockHost's real render graph) statically imports
  // `setTrpcBatchingEnabled` from this module (#2946). vi.mock replaces the module
  // wholesale, so the factory must re-declare it or the ESM link fails.
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
      getImagesByIds: { useMutation: () => ({ mutateAsync: mocks.getImagesByIds }) },
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
        report: { useMutation: () => ({ mutateAsync: mocks.report }) },
      },
    },
    useUtils: () => ({
      apps: {
        storage: {
          get: { fetch: mocks.storageGet },
          list: { fetch: mocks.storageList },
          getQuota: { fetch: mocks.storageGetQuota },
          invalidate: mocks.storageInvalidate,
        },
        shared: {
          list: { fetch: mocks.list },
          get: { fetch: mocks.get },
          getCount: { fetch: mocks.getCount },
          getCounts: { fetch: mocks.getCounts },
          // Router-level invalidate: what the hosts call after every shared
          // WRITE so the next read is not served from the staleTime:Infinity
          // cache. Present on the real utils; omitting it here would let a
          // broken wiring pass silently (the helper swallows throws by design).
          invalidate: mocks.invalidate,
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
    mocks.get.mockReset();
    mocks.getCount.mockReset();
    mocks.getCounts.mockReset();
    mocks.append.mockReset();
    mocks.update.mockReset();
    mocks.vote.mockReset();
    mocks.unvote.mockReset();
    mocks.withdraw.mockReset();
    mocks.report.mockReset();
    mocks.invalidate.mockReset();
    mocks.invalidate.mockResolvedValue(undefined);
    mocks.getImagesByIds.mockReset();
    mocks.saveDownload.mockReset();
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
      expect(mocks.list).toHaveBeenCalledWith(
        {
          blockToken: 'tok_abc',
          prefix: 'p',
          limit: 100,
          cursor: 'cur1',
        },
        { staleTime: BLOCK_STORAGE_READ_STALE_TIME_MS }
      );
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
      expect(mocks.getCount).toHaveBeenCalledWith(
        { blockToken: 'tok_abc', key: '01ABC' },
        { staleTime: BLOCK_STORAGE_READ_STALE_TIME_MS }
      );
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
      expect(mocks.getCounts).toHaveBeenCalledWith(
        { blockToken: 'tok_abc', keys: ['a', 'b'] },
        { staleTime: BLOCK_STORAGE_READ_STALE_TIME_MS }
      );
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

  // ── item 3: viewerVoted passes through SHARED_LIST ───────────────────────────
  test('SHARED_LIST passes the per-viewer viewerVoted flag through to the block', async () => {
    mocks.list.mockResolvedValue({
      items: [
        {
          key: '01ABC',
          authorUserId: 7,
          value: { title: 'voted' },
          count: 3,
          createdAt: new Date('2026-06-17T00:00:00.000Z'),
          updatedAt: new Date('2026-06-17T00:00:00.000Z'),
          viewerVoted: true,
        },
      ],
    });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_LIST', { requestId: 'rq_vv' });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_LIST_RESULT');
      if (!r) throw new Error('no reply yet');
      const payload = r.payload as { items: Array<{ viewerVoted?: boolean }> };
      expect(payload.items[0].viewerVoted).toBe(true);
    });
    replies.stop();
  });

  // ── item 6: SHARED_GET (single-row fetch-by-key) ─────────────────────────────
  test('SHARED_GET forwards key + host token and posts SHARED_GET_RESULT (item incl. viewerVoted)', async () => {
    mocks.get.mockResolvedValue({
      item: {
        key: '01ABC',
        authorUserId: 7,
        value: { title: 'Add dark mode' },
        count: 5,
        createdAt: new Date('2026-06-17T00:00:00.000Z'),
        updatedAt: new Date('2026-06-18T00:00:00.000Z'),
        viewerVoted: true,
      },
    });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_GET', { requestId: 'rq_get', key: '01ABC', blockToken: 'SPOOFED' });

    await vi.waitFor(() => {
      expect(mocks.get).toHaveBeenCalledWith(
        { blockToken: 'tok_abc', key: '01ABC' },
        { staleTime: BLOCK_STORAGE_READ_STALE_TIME_MS }
      );
    });
    await vi.waitFor(() => {
      const r = replies.last('SHARED_GET_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_get',
        item: {
          key: '01ABC',
          authorUserId: 7,
          value: { title: 'Add dark mode' },
          count: 5,
          createdAt: '2026-06-17T00:00:00.000Z',
          updatedAt: '2026-06-18T00:00:00.000Z',
          viewerVoted: true,
        },
      });
    });
    replies.stop();
  });

  test('SHARED_GET returns item:null for a missing/hidden key', async () => {
    mocks.get.mockResolvedValue({ item: null });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_GET', { requestId: 'rq_get_null', key: 'gone' });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_GET_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_get_null', item: null });
    });
    replies.stop();
  });

  test('SHARED_GET error path posts { requestId, item:null, error } (no hang)', async () => {
    mocks.get.mockRejectedValue(new Error('shared storage is not enabled'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_GET', { requestId: 'rq_get_err', key: 'k' });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_GET_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_get_err',
        item: null,
        error: 'shared storage is not enabled',
      });
    });
    replies.stop();
  });

  // ── item 5: SHARED_REPORT ────────────────────────────────────────────────────
  test('SHARED_REPORT forwards key + reason + host token and posts SHARED_REPORT_RESULT {ok:true}', async () => {
    mocks.report.mockResolvedValue({ ok: true });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_REPORT', {
      requestId: 'rq_rep',
      key: '01ABC',
      reason: 'harassment',
      blockToken: 'SPOOFED',
    });

    await vi.waitFor(() => {
      expect(mocks.report).toHaveBeenCalledWith({
        blockToken: 'tok_abc',
        key: '01ABC',
        reason: 'harassment',
      });
    });
    await vi.waitFor(() => {
      const r = replies.last('SHARED_REPORT_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_rep', ok: true });
    });
    replies.stop();
  });

  test('SHARED_REPORT error path posts { requestId, ok:false, error } (no hang)', async () => {
    mocks.report.mockRejectedValue(new Error('request not found'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_REPORT', { requestId: 'rq_rep_err', key: 'missing' });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_REPORT_RESULT');
      if (!r) throw new Error('no reply yet');
      // ok:false REQUIRED (the SDK validator drops a reply without a boolean ok).
      expect(r.payload).toEqual({ requestId: 'rq_rep_err', ok: false, error: 'request not found' });
    });
    replies.stop();
  });

  // ── item 1: SAVE_IMAGE (host download bridge) ────────────────────────────────
  test('SAVE_IMAGE url variant: an ALLOWLISTED civitai origin downloads + replies ok', async () => {
    mocks.saveDownload.mockResolvedValue(undefined);
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SAVE_IMAGE', {
      requestId: 'rq_save_url',
      url: 'https://image.civitai.com/xG/77/original.jpeg',
      filename: 'render.png',
    });

    await vi.waitFor(() => {
      expect(mocks.saveDownload).toHaveBeenCalledWith(
        'https://image.civitai.com/xG/77/original.jpeg',
        'render.png'
      );
    });
    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_save_url', ok: true });
    });
    replies.stop();
  });

  test('SAVE_IMAGE url variant: an ARBITRARY origin is REFUSED (ok:false, NO download)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SAVE_IMAGE', { requestId: 'rq_save_evil', url: 'https://evil.example/x.png' });

    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_save_evil',
        ok: false,
        error: 'image url is not allowed',
      });
    });
    // The disallowed URL was NEVER fetched host-side.
    expect(mocks.saveDownload).not.toHaveBeenCalled();
    replies.stop();
  });

  test('SAVE_IMAGE id variant: a VISIBLE image routes through the gated read + downloads', async () => {
    mocks.getImagesByIds.mockResolvedValue({
      images: [
        {
          imageId: 55,
          status: 'visible',
          nsfwLevel: 1,
          contentRating: 'g',
          url: 'https://image.civitai.com/edge/55.jpeg',
          width: 512,
          height: 512,
        },
      ],
    });
    mocks.saveDownload.mockResolvedValue(undefined);
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SAVE_IMAGE', { requestId: 'rq_save_id', imageId: 55 });

    await vi.waitFor(() => {
      // Routed through the SAME gated per-viewer read (host token bound).
      expect(mocks.getImagesByIds).toHaveBeenCalledWith({ blockToken: 'tok_abc', imageIds: [55] });
    });
    await vi.waitFor(() => {
      expect(mocks.saveDownload).toHaveBeenCalledWith(
        'https://image.civitai.com/edge/55.jpeg',
        '55.jpeg'
      );
    });
    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_save_id', ok: true });
    });
    replies.stop();
  });

  test('SAVE_IMAGE id variant: a WITHHELD (hidden) image is NEVER downloaded (ok:false)', async () => {
    mocks.getImagesByIds.mockResolvedValue({ images: [{ imageId: 55, status: 'hidden' }] });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SAVE_IMAGE', { requestId: 'rq_save_hidden', imageId: 55 });

    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_save_hidden',
        ok: false,
        error: 'image is not available',
      });
    });
    // The gated read ran, but a hidden image is never handed to the downloader.
    expect(mocks.getImagesByIds).toHaveBeenCalled();
    expect(mocks.saveDownload).not.toHaveBeenCalled();
    replies.stop();
  });

  test('SAVE_IMAGE id variant: an UNRESOLVABLE id (omitted from the gated read) is refused', async () => {
    mocks.getImagesByIds.mockResolvedValue({ images: [] });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SAVE_IMAGE', { requestId: 'rq_save_gone', imageId: 999 });

    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_save_gone',
        ok: false,
        error: 'image is not available',
      });
    });
    expect(mocks.saveDownload).not.toHaveBeenCalled();
    replies.stop();
  });

  test('SAVE_IMAGE with BOTH url and imageId is an invalid request (ok:false, no download)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SAVE_IMAGE', {
      requestId: 'rq_save_both',
      url: 'https://image.civitai.com/x.jpeg',
      imageId: 5,
    });

    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_save_both',
        ok: false,
        error: 'invalid save-image request',
      });
    });
    expect(mocks.saveDownload).not.toHaveBeenCalled();
    expect(mocks.getImagesByIds).not.toHaveBeenCalled();
    replies.stop();
  });

  test(`F2: caps concurrent SAVE_IMAGE downloads — the (N+1)th gets busy (N=${SAVE_IMAGE_MAX_CONCURRENT})`, async () => {
    // Make the host-side download hang so the first N requests each hold an
    // in-flight slot; the (N+1)th must be refused `busy` BEFORE it fetches (so a
    // hostile block can't download-bomb the tab).
    mocks.saveDownload.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    for (let i = 0; i < SAVE_IMAGE_MAX_CONCURRENT; i++) {
      postFromBlock('SAVE_IMAGE', {
        requestId: `rq_c${i}`,
        url: 'https://image.civitai.com/xG/77/original.jpeg',
      });
    }
    postFromBlock('SAVE_IMAGE', {
      requestId: 'rq_overflow',
      url: 'https://image.civitai.com/xG/77/original.jpeg',
    });

    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_overflow', ok: false, error: 'busy' });
    });
    // Only the N that acquired a slot reached the downloader; the overflow
    // short-circuited to busy BEFORE fetching a byte.
    expect(mocks.saveDownload).toHaveBeenCalledTimes(SAVE_IMAGE_MAX_CONCURRENT);
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
  // ── Shared read-cache invalidation (write → own next read) ───────────────────
  //
  // civitai's QueryClient is `staleTime: Infinity` (~/utils/trpc), and every
  // shared READ here goes through `trpcUtils.apps.shared.*.fetch` — React Query
  // `fetchQuery`, which never refetches a non-stale entry. So without an explicit
  // invalidation a block's own write is invisible to its own next read for the
  // whole page lifetime. See sharedStorageInvalidation.ts.

  test('SHARED_APPEND invalidates the shared read cache', async () => {
    mocks.append.mockResolvedValue({ key: '01NEW' });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_APPEND', { requestId: 'rq_inv', value: { title: 'x' } });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_APPEND_RESULT');
      if (!r) throw new Error('no reply yet');
    });
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    replies.stop();
  });

  test('SHARED_VOTE invalidates the shared read cache', async () => {
    mocks.vote.mockResolvedValue({ count: 2 });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_VOTE', { requestId: 'rq_inv_v', key: '01ABC' });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_VOTE_RESULT');
      if (!r) throw new Error('no reply yet');
    });
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    replies.stop();
  });

  test('the reply is WITHHELD until invalidation settles (ordering, not just presence)', async () => {
    // The ordering is the load-bearing half: the SDK hook resolves on the reply
    // and the block may re-read IMMEDIATELY, so invalidating after the reply
    // races the very read it exists to serve.
    //
    // This cannot be asserted by recording a call-order array: `send` posts a
    // message and the listener fires asynchronously, so a synchronous
    // `invalidate` would be recorded first whether it ran before or after the
    // send — a vacuous pass. Instead, hold invalidation OPEN and prove no reply
    // escapes while it is pending.
    let release!: () => void;
    mocks.invalidate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        })
    );
    mocks.append.mockResolvedValue({ key: '01GATED' });

    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_APPEND', { requestId: 'rq_gate', value: { title: 'gated' } });

    // The write itself has landed...
    await vi.waitFor(() => {
      expect(mocks.append).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    });
    // ...but the reply must NOT have been posted while invalidation is pending.
    //
    // 🔴 The wait is load-bearing, and its absence made an earlier version of
    // this test VACUOUS. `send` posts via postMessage, whose delivery is itself
    // async, so asserting absence immediately passes even when the reply was
    // already sent — it simply has not been DELIVERED yet. Measured: with the
    // invalidation moved to AFTER the send, the un-waited assertion still
    // passed (mutant survived).
    //
    // This is a fixed delay, not a queue drain: a postMessage task is queued
    // ahead of a 100ms timer, so by the time this resolves any already-posted
    // reply has been delivered. Its failure mode under extreme load is a
    // vacuous PASS, which is why the mutant above is re-run rather than trusted.
    await new Promise((r) => setTimeout(r, 100));
    expect(replies.last('SHARED_APPEND_RESULT')).toBeUndefined();

    release();

    await vi.waitFor(() => {
      const r = replies.last('SHARED_APPEND_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_gate', key: '01GATED' });
    });
    replies.stop();
  });

  test('a FAILED write does not invalidate (nothing changed server-side)', async () => {
    // Positive control on the negative: proves the invalidation is wired to the
    // success path specifically, not fired unconditionally on every message.
    mocks.append.mockRejectedValue(new Error('nope'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_APPEND', { requestId: 'rq_fail', value: { title: 'x' } });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_APPEND_RESULT');
      if (!r) throw new Error('no reply yet');
      expect((r.payload as { error?: string }).error).toBeTruthy();
    });
    expect(mocks.invalidate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('an invalidation FAILURE still reports the write as succeeded', async () => {
    // The helper swallows invalidation errors, and that property is
    // load-bearing rather than defensive: the write is already COMMITTED when
    // invalidation runs, so a throw escaping into the handler's try/catch would
    // send SHARED_APPEND_RESULT { error } for a row that exists. The block
    // would tell the user it failed, and a retry would duplicate it.
    //
    // Without this test the property had ZERO coverage — deleting the entire
    // try/catch left the whole suite green (found by adversarial audit).
    mocks.invalidate.mockRejectedValue(new Error('invalidation exploded'));
    mocks.append.mockResolvedValue({ key: '01COMMITTED' });

    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_APPEND', { requestId: 'rq_inv_fail', value: { title: 'x' } });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_APPEND_RESULT');
      if (!r) throw new Error('no reply yet');
      // Success shape, NOT an error shape.
      expect(r.payload).toEqual({ requestId: 'rq_inv_fail', key: '01COMMITTED' });
    });
    replies.stop();
  });

  test('a READ does not invalidate', async () => {
    // The other half of the same control: reads must not churn the cache.
    mocks.list.mockResolvedValue({ items: [], nextCursor: undefined });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_LIST', { requestId: 'rq_read' });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_LIST_RESULT');
      if (!r) throw new Error('no reply yet');
    });
    expect(mocks.invalidate).not.toHaveBeenCalled();
    replies.stop();
  });
});
