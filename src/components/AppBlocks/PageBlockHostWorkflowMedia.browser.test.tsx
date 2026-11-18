import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';

/**
 * GET_WORKFLOW_MEDIA → blocks.getWorkflowMedia → WORKFLOW_MEDIA_RESULT: stored
 * media refs become viewer-bound media URLs, judged server-side. Mounts the REAL
 * PageBlockHost and drives the actual postMessage bridge.
 */

const { workflowMediaMutate } = vi.hoisted(() => ({ workflowMediaMutate: vi.fn() }));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// eslint-disable-next-line local-rules/no-wholesale-module-mock -- the same mock every PageBlockHost suite uses; the Proxy stub's inert defaults leave this host unrendered
vi.mock('~/utils/trpc', () => ({
  setTrpcBatchingEnabled: vi.fn(),
  // eslint-disable-next-line local-rules/no-hand-enumerated-trpc-mock -- see above
  trpc: {
    // Collection follow/unfollow host bridge (SET_COLLECTION_FOLLOW). Both
    // hosts register the handler, so every host-rendering suite needs these
    // two session-authed mutations present on the mocked client.
    collection: {
      follow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      unfollow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    generation: {
      resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      resolveResourceFile: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
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
      getWorkflowMedia: { useMutation: () => ({ mutateAsync: workflowMediaMutate }) },
      // CREATE_POST_FROM_APP is TWO block-token mutations — the read-only preview
      // that resolves the consent payload, and the write. PageBlockHost reads both
      // at render, so a mock missing either makes the WHOLE component throw.
      previewPostFromApp: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      createPostFromApp: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
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
    last: (type: string) => [...received].reverse().find((m) => m.type === type),
    stop: () => cw.removeEventListener('message', handler),
  };
}

const SAME_ORIGIN_SRC = `${window.location.origin}/`;
const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'benchmark-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Benchmark App',
  iframeSrc: SAME_ORIGIN_SRC,
  // The public run surface. Required since the init-fragment gate keys on it.
  surface: 'page-run' as const,
  // Required. These suites cover the DEFAULT (host-veil) presentation;
  // the bootSkeleton path is covered in PageBlockHostLaunchReveal.
  bootSkeleton: false,
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

describe('PageBlockHost GET_WORKFLOW_MEDIA (per-viewer media read)', () => {
  beforeEach(() => {
    workflowMediaMutate.mockReset();
  });

  test('forwards the refs + token and replies the server result verbatim', async () => {
    const result = {
      media: [
        { status: 'visible', url: '/api/v1/blocks/media/bm1.t' },
        { status: 'pending' },
        { status: 'hidden', reason: 'above_level' },
      ],
    };
    workflowMediaMutate.mockResolvedValue(result);
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_WORKFLOW_MEDIA', { requestId: 'rq_wm', refs: ['bm1.a', 'bm1.b', 'bm1.c'] });

    await vi.waitFor(() => {
      const r = replies.last('WORKFLOW_MEDIA_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_wm', result });
      expectReplyKeys('GET_WORKFLOW_MEDIA', 'success', ['result'], r.payload);
    });
    expect(workflowMediaMutate).toHaveBeenCalledWith({
      blockToken: 'tok_abc',
      refs: ['bm1.a', 'bm1.b', 'bm1.c'],
    });
    replies.stop();
  });

  test('a refused read settles the block with an error instead of hanging', async () => {
    workflowMediaMutate.mockRejectedValue(new Error('Apps are not enabled'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_WORKFLOW_MEDIA', { requestId: 'rq_err', refs: ['bm1.a'] });

    await vi.waitFor(() => {
      const r = replies.last('WORKFLOW_MEDIA_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_err', error: 'Apps are not enabled' });
      expectReplyKeys('GET_WORKFLOW_MEDIA', 'error', ['error'], r.payload);
    });
    replies.stop();
  });

  test('an empty ref list replies an empty result without a server call', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_WORKFLOW_MEDIA', { requestId: 'rq_empty', refs: [] });

    await vi.waitFor(() => {
      const r = replies.last('WORKFLOW_MEDIA_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_empty', result: { media: [] } });
    });
    expect(workflowMediaMutate).not.toHaveBeenCalled();
    replies.stop();
  });
});
