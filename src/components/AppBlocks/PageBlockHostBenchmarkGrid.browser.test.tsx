import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * App Blocks Model-Benchmarking shared-grid host bridges — the host-handler tests
 * for the two new page-only affordances:
 *   • PUBLISH_GENERATION_OUTPUTS → HOST-CHROME CONSENT confirm → (on confirm)
 *     blocks.publishGenerationOutputs → PUBLISH_RESULT. The explicit confirm click
 *     is the consent boundary; a dismiss settles the block with an error.
 *   • GET_IMAGES_BY_IDS → blocks.getImagesByIds → IMAGES_RESULT (per-viewer gated;
 *     an empty id list short-circuits to an empty result without a server call).
 *
 * Mounts the REAL PageBlockHost and drives the actual postMessage bridge.
 */

const { publishMutate, getImagesMutate } = vi.hoisted(() => ({
  publishMutate: vi.fn(),
  getImagesMutate: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', () => ({
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    generation: { resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
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
      publishGenerationOutputs: { useMutation: () => ({ mutateAsync: publishMutate }) },
      getImagesByIds: { useMutation: () => ({ mutateAsync: getImagesMutate }) },
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
        storage: { get: { fetch: vi.fn() }, list: { fetch: vi.fn() }, getQuota: { fetch: vi.fn() } },
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
  blockId: 'benchmark-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Benchmark App',
  iframeSrc: SAME_ORIGIN_SRC,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'benchmark-app',
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

type ConfirmProps = { onConfirm: () => Promise<void> | void; onCancel: () => void };

describe('PageBlockHost PUBLISH_GENERATION_OUTPUTS (consent-gated publish)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    publishMutate.mockReset();
  });

  test('opens a host-chrome consent confirm; on CONFIRM calls the mutation (token bound) and replies imageIds', async () => {
    publishMutate.mockResolvedValue({ imageIds: [101, 102] });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('PUBLISH_GENERATION_OUTPUTS', {
      requestId: 'rq_pub',
      workflowId: 'wf_1',
      imageIndexes: [0, 1],
    });

    // A confirm dialog (consent) opens BEFORE any mutation.
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    expect(publishMutate).not.toHaveBeenCalled();

    // Simulate the user clicking "Publish".
    await (lastDialog().props as ConfirmProps).onConfirm();

    expect(publishMutate).toHaveBeenCalledWith({
      blockToken: 'tok_abc',
      workflowId: 'wf_1',
      imageIndexes: [0, 1],
    });
    await vi.waitFor(() => {
      const r = replies.last('PUBLISH_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_pub', result: { imageIds: [101, 102] } });
    });
    replies.stop();
  });

  test('on DISMISS (consent declined) replies an error and NEVER calls the mutation', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('PUBLISH_GENERATION_OUTPUTS', { requestId: 'rq_no', workflowId: 'wf_2' });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));

    (lastDialog().props as ConfirmProps).onCancel();

    await vi.waitFor(() => {
      const r = replies.last('PUBLISH_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_no', error: 'publish canceled' });
    });
    expect(publishMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('an empty imageIndexes means "publish all" — the mutation is called WITHOUT imageIndexes', async () => {
    publishMutate.mockResolvedValue({ imageIds: [7] });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('PUBLISH_GENERATION_OUTPUTS', {
      requestId: 'rq_all',
      workflowId: 'wf_all',
      imageIndexes: [],
    });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    await (lastDialog().props as ConfirmProps).onConfirm();

    // Empty selection normalizes to "publish all" — no imageIndexes on the wire
    // (so the server never sees `[]` → BAD_REQUEST).
    expect(publishMutate).toHaveBeenCalledWith({ blockToken: 'tok_abc', workflowId: 'wf_all' });
    await vi.waitFor(() => {
      const r = replies.last('PUBLISH_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_all', result: { imageIds: [7] } });
    });
    replies.stop();
  });

  test('a request with no workflowId is dropped (no consent dialog, no reply)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('PUBLISH_GENERATION_OUTPUTS', { requestId: 'rq_bad' });

    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(replies.last('PUBLISH_RESULT')).toBeUndefined();
    expect(publishMutate).not.toHaveBeenCalled();
    replies.stop();
  });
});

describe('PageBlockHost GET_IMAGES_BY_IDS (per-viewer gated read)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    getImagesMutate.mockReset();
  });

  test('forwards the ids + token and replies the gated projection (visible + hidden)', async () => {
    const images = [
      { imageId: 1, status: 'visible', nsfwLevel: 1, contentRating: 'g', url: 'edge:1', width: 512, height: 512 },
      { imageId: 2, status: 'hidden' },
    ];
    getImagesMutate.mockResolvedValue({ images });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_IMAGES_BY_IDS', { requestId: 'rq_get', imageIds: [1, 2] });

    expect(getImagesMutate).toHaveBeenCalledWith({ blockToken: 'tok_abc', imageIds: [1, 2] });
    await vi.waitFor(() => {
      const r = replies.last('IMAGES_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_get', result: { images } });
    });
    // The hidden entry carries NO url on the wire.
    const payload = replies.last('IMAGES_RESULT')!.payload as {
      result: { images: Array<Record<string, unknown>> };
    };
    expect(payload.result.images[1]).not.toHaveProperty('url');
    replies.stop();
  });

  test('an empty id list short-circuits to an empty result WITHOUT a server call', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_IMAGES_BY_IDS', { requestId: 'rq_empty', imageIds: [] });

    await vi.waitFor(() => {
      const r = replies.last('IMAGES_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_empty', result: { images: [] } });
    });
    expect(getImagesMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a server error is surfaced as the IMAGES_RESULT error variant', async () => {
    getImagesMutate.mockRejectedValue(new Error('boom'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_IMAGES_BY_IDS', { requestId: 'rq_err', imageIds: [5] });

    await vi.waitFor(() => {
      const r = replies.last('IMAGES_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_err', error: 'boom' });
    });
    replies.stop();
  });
});
