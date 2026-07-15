import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import type { BlockUploadedImageInfo } from '~/components/AppBlocks/BlockImageUploadModal';
import type { BlockSourceImageInfo } from '~/components/AppBlocks/BlockGenerationSourceUploadModal';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * App Blocks PAGE image upload (OPEN_IMAGE_UPLOAD) — the host-handler BRANCH test.
 *
 * A full-page App Block posts OPEN_IMAGE_UPLOAD; the optional `purpose` selects
 * which host modal opens and which reply shape comes back:
 *   • 'display' (default / absent) → the MODERATED BlockImageUploadModal
 *     (createImage + scan + SFW gate) → { imageId, nsfwLevel, contentRating, url }.
 *   • 'generationSource' → the UNSCANNED BlockGenerationSourceUploadModal
 *     (uploadConsumerBlob, NO createImage/scan/gate) → { url, width, height }.
 *
 * These tests mount the REAL PageBlockHost and drive the actual postMessage
 * bridge. Following the OPEN_RESOURCE_PICKER test pattern, the dynamic-import
 * modals aren't rendered here; we assert the host opened the CORRECT modal (by
 * dialog id) and invoke its captured `onResolved` to simulate the user's upload,
 * then assert the IMAGE_UPLOAD_RESULT reply shape. The correct-modal assertion is
 * itself the proof that generationSource does NOT hit the moderated scan/gate
 * path (it opens the consumer-blob modal, never BlockImageUploadModal), and that
 * 'display' is unchanged. The modal-internal upload behavior (that
 * generationSource uses uploadConsumerBlob and never calls blockImageUpload) is
 * covered directly in BlockGenerationSourceUploadModal.browser.test.tsx.
 */

// Stub trpc so PageBlockHost mounts network-free (same shape as the resource-
// picker test). The image-upload branch itself makes no tRPC call from the host —
// the moderated path's persist/gate live INSIDE the (unrendered) modal.
vi.mock('~/utils/trpc', () => ({
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    generation: { resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    apps: {
      shared: {
        append: { useMutation: () => ({ mutateAsync: vi.fn() }) },
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
    new MessageEvent('message', {
      data: { type, payload },
      origin: window.location.origin,
      source: cw,
    })
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

describe('PageBlockHost OPEN_IMAGE_UPLOAD (purpose branch)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
  });

  test("generationSource opens the UNSCANNED consumer-blob modal (NOT the moderated one) and replies { url, width, height }", async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_src', purpose: 'generationSource' });

    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    // The generationSource branch opens the generation-source modal — proof it
    // does NOT route to the moderated scan/gate modal.
    expect(lastDialog().id).toBe('block-generation-source-upload-rq_src');
    expect(lastDialog().id).not.toBe('block-image-upload-rq_src');

    // Simulate a successful consumer-blob upload inside the modal.
    const onResolved = (lastDialog().props as { onResolved: (r: BlockSourceImageInfo) => void })
      .onResolved;
    const source: BlockSourceImageInfo = {
      url: 'https://orchestration.civitai.com/v2/consumer/blobs/ABC123.jpeg?sig=x&exp=2030-01-01T00:00:00Z',
      width: 768,
      height: 512,
    };
    onResolved(source);
    // The modal closes itself after a successful upload → the dialog's
    // options.onClose (where the host posts the reply) fires.
    lastDialog().options?.onClose?.();

    await vi.waitFor(() => {
      const r = replies.last('IMAGE_UPLOAD_RESULT');
      if (!r) throw new Error('no reply yet');
      // EXACTLY the source projection — no imageId / nsfwLevel / contentRating.
      expect(r.payload).toEqual({ requestId: 'rq_src', selected: source });
    });
    const sel = (replies.last('IMAGE_UPLOAD_RESULT')!.payload as { selected: Record<string, unknown> })
      .selected;
    expect(Object.keys(sel).sort()).toEqual(['height', 'url', 'width']);
    for (const k of ['imageId', 'nsfwLevel', 'contentRating']) expect(sel).not.toHaveProperty(k);
    replies.stop();
  });

  test("display (explicit) opens the MODERATED modal and replies the moderated projection (unchanged)", async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_disp', purpose: 'display' });

    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    expect(lastDialog().id).toBe('block-image-upload-rq_disp');

    const onResolved = (lastDialog().props as { onResolved: (r: BlockUploadedImageInfo) => void })
      .onResolved;
    const moderated: BlockUploadedImageInfo = {
      imageId: 55,
      nsfwLevel: 1,
      contentRating: 'PG' as BlockUploadedImageInfo['contentRating'],
      url: 'https://image.civitai.com/xG/55/original.jpeg',
    };
    onResolved(moderated);
    lastDialog().options?.onClose?.();

    await vi.waitFor(() => {
      const r = replies.last('IMAGE_UPLOAD_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_disp', selected: moderated });
    });
    replies.stop();
  });

  test("an ABSENT purpose defaults to the moderated 'display' modal (SDK back-compat)", async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    // Exactly what the current SDK sends today: a bare requestId, no purpose.
    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_bare' });

    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    expect(lastDialog().id).toBe('block-image-upload-rq_bare');
  });

  test('generationSource cancel (close without upload) posts a bare (cancelled) result', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_cancel', purpose: 'generationSource' });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));

    // User dismisses without a successful upload — onResolved never called, so
    // the dialog's options.onClose posts a bare (cancelled) result.
    lastDialog().options?.onClose?.();

    await vi.waitFor(() => {
      const r = replies.last('IMAGE_UPLOAD_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_cancel' });
    });
    replies.stop();
  });

  test('a request with no requestId is dropped (no modal, no reply) regardless of purpose', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_IMAGE_UPLOAD', { purpose: 'generationSource' });

    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(replies.last('IMAGE_UPLOAD_RESULT')).toBeUndefined();
    replies.stop();
  });
});
