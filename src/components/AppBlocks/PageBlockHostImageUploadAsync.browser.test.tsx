import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import type { BlockUploadedImageInfo } from '~/components/AppBlocks/BlockImageUploadModal';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * App Blocks PAGE image upload — the ASYNC (non-blocking) scan branch of
 * OPEN_IMAGE_UPLOAD (`asyncScan: true` + display).
 *
 * Target behavior: the host modal resolves EARLY on persist — replying
 * IMAGE_UPLOAD_RESULT with a PENDING handle `{ status:'pending', imageId, url }`
 * and closing — while a host-mounted BlockImageScanPoller (which survives the
 * modal close) polls the authoritative gate and later streams the verdict as the
 * parent→block IMAGE_SCAN_RESOLVED push.
 *
 * Like the sibling purpose-branch test, the dynamic-import modal isn't rendered;
 * we capture its `onAccepted` (async early-resolve) / `onResolved` props from the
 * dialog and invoke them to simulate the user's upload. The POLLER, however, IS
 * rendered by the real PageBlockHost — so the gate mutation is driven by the
 * programmable `gateMutateAsync` mock below to exercise scanned / blocked / error.
 */

const h = vi.hoisted(() => ({ gateMutateAsync: vi.fn() }));

vi.mock('~/utils/trpc', () => ({
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    generation: { resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
    blockImageUpload: {
      persist: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      // The host-mounted poller's gate mutation — programmable per test.
      gate: { useMutation: () => ({ mutateAsync: h.gateMutateAsync }) },
    },
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzTransactions: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzAccounts: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyDailyCompensation: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
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

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

function postFromBlock(type: string, payload?: unknown) {
  const iframeEl = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
  const cw = iframeEl.contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  window.dispatchEvent(
    new MessageEvent('message', { data: { type, payload }, origin: window.location.origin, source: cw })
  );
}

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
    count: (type: string) => received.filter((m) => m.type === type).length,
    stop: () => cw.removeEventListener('message', handler),
  };
}

function lastDialog() {
  const dialogs = useDialogStore.getState().dialogs;
  if (dialogs.length === 0) throw new Error('no modal opened');
  return dialogs[dialogs.length - 1];
}

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'my-page-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Gen App',
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

// Open the async upload, capture the modal's onAccepted, then simulate the modal's
// early-resolve (persist done → onAccepted → modal closes).
function acceptUpload(requestId: string, handle: { imageId: number; url: string }) {
  const props = lastDialog().props as {
    onAccepted?: (h: { imageId: number; url: string }) => void;
  };
  if (!props.onAccepted) throw new Error('modal was not opened in async (onAccepted) mode');
  props.onAccepted(handle);
  // The modal calls dialog.onClose() right after onAccepted; replay that.
  lastDialog().options?.onClose?.();
}

const READY_IMAGE: BlockUploadedImageInfo = {
  imageId: 77,
  nsfwLevel: 1,
  contentRating: 'PG' as BlockUploadedImageInfo['contentRating'],
  url: 'https://image.civitai.com/xG/77/width=1200/original.jpeg',
};

describe('PageBlockHost OPEN_IMAGE_UPLOAD (asyncScan branch)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    h.gateMutateAsync.mockReset();
  });

  test('early-resolve: accept replies a PENDING handle and closes the modal', async () => {
    // Gate never asked to resolve within this test — keep it pending so no verdict races.
    h.gateMutateAsync.mockResolvedValue({ status: 'pending' });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_async', asyncScan: true });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    // The MODERATED modal is opened (async is a display-only mode).
    expect(lastDialog().id).toBe('block-image-upload-rq_async');

    acceptUpload('rq_async', { imageId: 77, url: 'https://image.civitai.com/xG/77/width=1200/x.jpeg' });

    await vi.waitFor(() => {
      const r = replies.last('IMAGE_UPLOAD_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_async',
        selected: { status: 'pending', imageId: 77, url: 'https://image.civitai.com/xG/77/width=1200/x.jpeg' },
      });
    });
    // Auto-close semantics: the host replied EXACTLY ONCE on accept — the modal's
    // simulated onClose (accepted=true) must NOT emit a second/bare result (the
    // accepted-guard), so the block never sees a spurious cancel after the pending
    // handle. (The modal's own dialog.onClose() is a modal-internal behavior,
    // covered where the modal is rendered.)
    await new Promise((r) => setTimeout(r, 100));
    expect(replies.count('IMAGE_UPLOAD_RESULT')).toBe(1);
    replies.stop();
  });

  test('pending → scanned: the poller streams IMAGE_SCAN_RESOLVED with the moderated image', async () => {
    h.gateMutateAsync.mockResolvedValue({ status: 'ready', ...READY_IMAGE });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_scan', asyncScan: true });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    acceptUpload('rq_scan', { imageId: 77, url: 'https://preview/x.jpeg' });

    await vi.waitFor(() => {
      const r = replies.last('IMAGE_SCAN_RESOLVED');
      if (!r) throw new Error('no verdict yet');
      expect(r.payload).toEqual({
        requestId: 'rq_scan',
        imageId: 77,
        result: { status: 'scanned', image: READY_IMAGE },
      });
    });
    expect(h.gateMutateAsync).toHaveBeenCalledWith({ imageId: 77 });
    // Emitted exactly once.
    expect(replies.count('IMAGE_SCAN_RESOLVED')).toBe(1);
    replies.stop();
  });

  test('pending → blocked: a BAD_REQUEST gate throw streams blocked, leaking NO moderated image', async () => {
    h.gateMutateAsync.mockRejectedValue({
      data: { code: 'BAD_REQUEST' },
      message: 'that image was rejected during scanning — choose a different image',
    });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_block', asyncScan: true });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    acceptUpload('rq_block', { imageId: 88, url: 'https://preview/y.jpeg' });

    await vi.waitFor(() => {
      const r = replies.last('IMAGE_SCAN_RESOLVED');
      if (!r) throw new Error('no verdict yet');
      const payload = r.payload as { requestId: string; imageId: number; result: Record<string, unknown> };
      expect(payload.requestId).toBe('rq_block');
      expect(payload.result.status).toBe('blocked');
      expect(payload.result.reason).toContain('rejected during scanning');
      // A blocked verdict must carry NO block-usable moderated image.
      expect(payload.result).not.toHaveProperty('image');
    });
    replies.stop();
  });

  test('scan error: a NOT_FOUND / network gate throw streams a RETRYABLE error (not blocked)', async () => {
    h.gateMutateAsync.mockRejectedValue({ data: { code: 'NOT_FOUND' }, message: 'Image not found' });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_err', asyncScan: true });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    acceptUpload('rq_err', { imageId: 99, url: 'https://preview/z.jpeg' });

    await vi.waitFor(() => {
      const r = replies.last('IMAGE_SCAN_RESOLVED');
      if (!r) throw new Error('no verdict yet');
      const payload = r.payload as { result: { status: string; message?: string } };
      expect(payload.result.status).toBe('error');
      expect(payload.result.message).toBe('Image not found');
    });
    replies.stop();
  });

  test('dismiss (close without accept): a bare IMAGE_UPLOAD_RESULT, NO poller, NO gate call', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_dismiss', asyncScan: true });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));

    // User closes without accepting — onAccepted never fires.
    lastDialog().options?.onClose?.();

    await vi.waitFor(() => {
      const r = replies.last('IMAGE_UPLOAD_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_dismiss' });
    });
    // No poller registered → no scan verdict, no gate mutation.
    await new Promise((r) => setTimeout(r, 150));
    expect(replies.last('IMAGE_SCAN_RESOLVED')).toBeUndefined();
    expect(h.gateMutateAsync).not.toHaveBeenCalled();
    replies.stop();
  });
});
