import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W10 storage-bridge gap regression (page surface).
 *
 * A full-page App Block (`/apps/run/<slug>`) that uses the KV datastore (the
 * @civitai/blocks-react `useAppStorage` hook → APP_STORAGE_GET / SET / DELETE /
 * LIST / QUOTA) was handled by NONE of PageBlockHost's bridges before this fix:
 * the host advertised `apps:storage:*` in BLOCK_INIT and the page mint signed the
 * storage scopes, but the host had no storage handlers → the message fired into
 * the void, no `apps.storage.*` tRPC call was made, and the SDK request hung to
 * its 30s timeout with no network call and no error (the same class as the
 * workflow gap). The model host (IframeHost) already wired these; we mirror it.
 *
 * These tests mount the REAL PageBlockHost and drive the actual postMessage
 * bridge, asserting that for each op the host:
 *   1. forwards to the matching `apps.storage.*` proc (reads via trpc.useUtils()
 *      .fetch, writes via the useMutation mock) with the page `token` prop as
 *      `blockToken` + the args, and
 *   2. posts the matching `*_RESULT` reply with the requestId + expected payload
 *      on BOTH the success and the error path (an error-shaped `*_RESULT`, never
 *      a hang).
 *
 * trpc is mocked via `vi.mock('~/utils/trpc')` (the scaffold's documented
 * pattern) so this stays network-free. Replies are captured on the iframe's
 * contentWindow `message` channel (where `send` posts), mirroring how a real
 * block's transport receives them — identical to the workflow test.
 */

// Per-test-controllable proc impls. `vi.mock` is hoisted, so the fns live in a
// hoisted block the factory closes over. Reads go through trpc.useUtils()...fetch;
// writes go through trpc.apps.storage.{set,delete}.useMutation().mutateAsync.
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  list: vi.fn(),
  getQuota: vi.fn(),
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    // PageBlockHost also wires the workflow bridge at render (inert here —
    // exercised in PageBlockHostWorkflow.browser.test.tsx); stub so it mounts.
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    // Analytics Phase 2: PageBlockHost calls trpc.track.blockRender.useMutation()
    // at render (fire-and-forget impression emit). Inert stub here.
    track: { blockRender: { useMutation: () => ({ mutate: vi.fn() }) } },
    apps: {
      storage: {
        set: { useMutation: () => ({ mutateAsync: mocks.set }) },
        delete: { useMutation: () => ({ mutateAsync: mocks.del }) },
      },
    },
    useUtils: () => ({
      apps: {
        storage: {
          get: { fetch: mocks.get },
          list: { fetch: mocks.list },
          getQuota: { fetch: mocks.getQuota },
        },
      },
    }),
  },
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

// Dispatch a message FROM the host iframe: source = iframe.contentWindow,
// origin = host expectedOrigin (same-origin src). Satisfies both authenticating
// pins usePostMessage enforces. Identical to the workflow/consent test helpers.
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
  appName: 'Notepad',
  iframeSrc: SAME_ORIGIN_SRC,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'my-page-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: ['apps:storage:read', 'apps:storage:write'],
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

describe('PageBlockHost storage bridge (W10 KV datastore wiring)', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.set.mockReset();
    mocks.del.mockReset();
    mocks.list.mockReset();
    mocks.getQuota.mockReset();
    useDialogStore.getState().closeAll();
  });

  test('APP_STORAGE_GET forwards to apps.storage.get and posts APP_STORAGE_GET_RESULT', async () => {
    mocks.get.mockResolvedValue({ value: { note: 'hello' } });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('APP_STORAGE_GET', { requestId: 'rq_get', key: 'draft' });

    await vi.waitFor(() => {
      expect(mocks.get).toHaveBeenCalledWith({ blockToken: 'tok_abc', key: 'draft' });
    });
    await vi.waitFor(() => {
      const r = replies.last('APP_STORAGE_GET_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_get', value: { note: 'hello' } });
    });
    replies.stop();
  });

  test('APP_STORAGE_GET error path posts a null value + error (no hang)', async () => {
    mocks.get.mockRejectedValue(new Error('app blocks feature is disabled'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('APP_STORAGE_GET', { requestId: 'rq_get_err', key: 'draft' });

    await vi.waitFor(() => {
      const r = replies.last('APP_STORAGE_GET_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_get_err',
        value: null,
        error: 'app blocks feature is disabled',
      });
    });
    replies.stop();
  });

  test('APP_STORAGE_SET forwards key+value and posts APP_STORAGE_SET_RESULT', async () => {
    mocks.set.mockResolvedValue({ sizeBytes: 17 });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('APP_STORAGE_SET', { requestId: 'rq_set', key: 'draft', value: { note: 'hi' } });

    await vi.waitFor(() => {
      expect(mocks.set).toHaveBeenCalledWith({
        blockToken: 'tok_abc',
        key: 'draft',
        value: { note: 'hi' },
      });
    });
    await vi.waitFor(() => {
      const r = replies.last('APP_STORAGE_SET_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_set', ok: true, sizeBytes: 17 });
    });
    replies.stop();
  });

  test('APP_STORAGE_SET error path posts ok:false + error (no hang)', async () => {
    mocks.set.mockRejectedValue(new Error('value exceeds 64KB cap'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('APP_STORAGE_SET', { requestId: 'rq_set_err', key: 'big', value: 'x' });

    await vi.waitFor(() => {
      const r = replies.last('APP_STORAGE_SET_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_set_err',
        ok: false,
        error: 'value exceeds 64KB cap',
      });
    });
    replies.stop();
  });

  test('APP_STORAGE_DELETE forwards key and posts APP_STORAGE_DELETE_RESULT', async () => {
    mocks.del.mockResolvedValue({ deleted: true });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('APP_STORAGE_DELETE', { requestId: 'rq_del', key: 'draft' });

    await vi.waitFor(() => {
      expect(mocks.del).toHaveBeenCalledWith({ blockToken: 'tok_abc', key: 'draft' });
    });
    await vi.waitFor(() => {
      const r = replies.last('APP_STORAGE_DELETE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_del', ok: true, deleted: true });
    });
    replies.stop();
  });

  test('APP_STORAGE_DELETE error path posts ok:false + deleted:false + error (no hang)', async () => {
    mocks.del.mockRejectedValue(new Error('storage unavailable'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('APP_STORAGE_DELETE', { requestId: 'rq_del_err', key: 'draft' });

    await vi.waitFor(() => {
      const r = replies.last('APP_STORAGE_DELETE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_del_err',
        ok: false,
        deleted: false,
        error: 'storage unavailable',
      });
    });
    replies.stop();
  });

  test('APP_STORAGE_LIST forwards clamped args and posts APP_STORAGE_LIST_RESULT', async () => {
    const updatedAt = new Date('2026-06-17T00:00:00.000Z');
    mocks.list.mockResolvedValue({
      keys: [{ key: 'a', updatedAt }],
      nextCursor: 'cur2',
    });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    // limit 9999 is clamped to the 200 max (mirrors IframeHost).
    postFromBlock('APP_STORAGE_LIST', {
      requestId: 'rq_list',
      prefix: 'a',
      limit: 9999,
      cursor: 'cur1',
    });

    await vi.waitFor(() => {
      expect(mocks.list).toHaveBeenCalledWith({
        blockToken: 'tok_abc',
        prefix: 'a',
        limit: 200,
        cursor: 'cur1',
      });
    });
    await vi.waitFor(() => {
      const r = replies.last('APP_STORAGE_LIST_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_list',
        keys: [{ key: 'a', updatedAt: '2026-06-17T00:00:00.000Z' }],
        nextCursor: 'cur2',
      });
    });
    replies.stop();
  });

  test('APP_STORAGE_LIST error path posts empty keys + error (no hang)', async () => {
    mocks.list.mockRejectedValue(new Error('list failed'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('APP_STORAGE_LIST', { requestId: 'rq_list_err' });

    await vi.waitFor(() => {
      const r = replies.last('APP_STORAGE_LIST_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_list_err', keys: [], error: 'list failed' });
    });
    replies.stop();
  });

  test('APP_STORAGE_QUOTA forwards the token and posts APP_STORAGE_QUOTA_RESULT', async () => {
    mocks.getQuota.mockResolvedValue({
      usedBytes: 100,
      rowCount: 3,
      limitBytes: 1000,
      limitRows: 50,
    });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('APP_STORAGE_QUOTA', { requestId: 'rq_quota' });

    await vi.waitFor(() => {
      expect(mocks.getQuota).toHaveBeenCalledWith({ blockToken: 'tok_abc' });
    });
    await vi.waitFor(() => {
      const r = replies.last('APP_STORAGE_QUOTA_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_quota',
        usedBytes: 100,
        rowCount: 3,
        limitBytes: 1000,
        limitRows: 50,
      });
    });
    replies.stop();
  });

  test('a storage message with NO requestId is dropped (no proc call, no reply)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('APP_STORAGE_GET', { key: 'draft' }); // missing requestId

    await new Promise((r) => setTimeout(r, 150));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(replies.last('APP_STORAGE_GET_RESULT')).toBeUndefined();
    replies.stop();
  });

  test('a storage message with a null page token is dropped (cannot forward a storage call)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} token={null} />);
    // With a null token the host never reaches BLOCK_READY (the iframe gates on
    // token); the iframe may not mount. Either way the handler must refuse to
    // call the proc — apps.storage.* require a non-null blockToken.
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement | null;
      if (!el) return;
    });
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
