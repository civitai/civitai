import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
import type * as TrpcMod from '~/utils/trpc';

/**
 * PERSIST_GENERATION_SOURCE on the PAGE host. Mounts the REAL PageBlockHost and drives the real
 * postMessage bridge. Pins: NO dialog opens, the procedure is called with the page token and the
 * block's workflowId + index, and every path with a requestId replies exactly once —
 * success, server failure, review mode (run-for-real included), before the handshake, no token,
 * and an invalid payload.
 */

const { persistMutate } = vi.hoisted(() => ({ persistMutate: vi.fn() }));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeInertSubRouter, makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  // The handler calls the procedure through the VANILLA client (`useUtils().client`).
  const baseUtils = (makeTrpcProxy() as { useUtils: () => object }).useUtils();
  const client = { blocks: { persistGenerationSource: { mutate: persistMutate } } };
  const utils = new Proxy(baseUtils, {
    get: (target, key) => (key === 'client' ? client : Reflect.get(target, key)),
  });
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    setTrpcBatchingEnabled: vi.fn(),
    trpc: makeTrpcProxy(
      {
        'apps.shared': makeInertSubRouter(),
        'apps.storage': makeInertSubRouter(),
      },
      { useUtils: () => utils }
    ),
  };
});

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
// eslint-disable-next-line import/first
import {
  PERSIST_SOURCE_INVALID_ERROR,
  PERSIST_SOURCE_NOT_READY_ERROR,
  PERSIST_SOURCE_REVIEW_ERROR,
} from '~/components/AppBlocks/pageBlockHostLogic';

function iframeEl() {
  return page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
}

function postFromBlock(type: string, payload?: unknown) {
  const cw = iframeEl().contentWindow;
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
  const cw = iframeEl().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  };
  cw.addEventListener('message', handler);
  return {
    of: (type: string) => received.filter((m) => m.type === type),
    stop: () => cw.removeEventListener('message', handler),
  };
}

const SAME_ORIGIN_SRC = `${window.location.origin}/`;
const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'remix-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Remix',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'remix-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: ['ai:write:budgeted'] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' } as { id: number; username: string | null } | null,
  theme: 'light' as const,
};

async function mount(
  over: Partial<typeof baseProps> & { reviewMode?: boolean; reviewRunForReal?: boolean } = {},
  opts: { handshake?: boolean } = {}
) {
  renderWithProviders(
    <PageBlockHost
      {...baseProps}
      {...over}
      {...(over.reviewMode ? { onConsentGranted: vi.fn() } : {})}
    />
  );
  await vi.waitFor(() => {
    if (!iframeEl().contentWindow) throw new Error('not mounted yet');
  });
  const replies = listenForReply();
  if (opts.handshake !== false) {
    await vi.waitFor(() => {
      postFromBlock('BLOCK_READY', {});
      if (iframeEl().getAttribute('data-block-ready') !== 'true') throw new Error('not ready');
    });
  }
  return replies;
}

/** Wait for the first reply of `type`, then a beat more, and return them all. */
async function settled(replies: ReturnType<typeof listenForReply>, type: string) {
  await vi.waitFor(() => {
    if (replies.of(type).length === 0) throw new Error(`no ${type} yet`);
  });
  await new Promise((r) => setTimeout(r, 100));
  return replies.of(type);
}

const REQUEST = { requestId: 'rq_src', workflowId: 'wf_1', imageIndex: 2 };
const RESULT = {
  url: 'https://image.civitai.com/x/00000000-0000-4000-8000-000000000001/original=true/a.jpeg',
  width: 640,
  height: 320,
  imageId: 9001,
  ready: true,
};
const REPLY = 'GENERATION_SOURCE_PERSISTED';

describe('PageBlockHost PERSIST_GENERATION_SOURCE (private source, no dialog)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    persistMutate.mockReset();
  });

  test('🔴 opens NO dialog, calls the procedure with the page token, and replies the result once', async () => {
    persistMutate.mockResolvedValue(RESULT);
    const replies = await mount();
    postFromBlock('PERSIST_GENERATION_SOURCE', REQUEST);
    const out = await settled(replies, REPLY);
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(persistMutate).toHaveBeenCalledTimes(1);
    expect(persistMutate).toHaveBeenCalledWith({
      blockToken: 'tok_abc',
      workflowId: 'wf_1',
      imageIndex: 2,
    });
    expect(out).toHaveLength(1);
    expect(out[0].payload).toEqual({ requestId: 'rq_src', result: RESULT });
    expectReplyKeys('PERSIST_GENERATION_SOURCE', 'success', ['result'], out[0].payload);
    replies.stop();
  });

  test('a server refusal is replied as an error, once', async () => {
    persistMutate.mockRejectedValue(new Error('workflow is not in this app subqueue'));
    const replies = await mount();
    postFromBlock('PERSIST_GENERATION_SOURCE', REQUEST);
    const out = await settled(replies, REPLY);
    expect(out).toHaveLength(1);
    expect(out[0].payload).toEqual({
      requestId: 'rq_src',
      error: 'workflow is not in this app subqueue',
    });
    expectReplyKeys('PERSIST_GENERATION_SOURCE', 'error', ['error'], out[0].payload);
    replies.stop();
  });

  test.each([
    ['review mode', { reviewMode: true }],
    ['review mode with run-for-real', { reviewMode: true, reviewRunForReal: true }],
  ])('🔴 %s: refused with an error and no call', async (_label, over) => {
    const replies = await mount(over);
    postFromBlock('PERSIST_GENERATION_SOURCE', REQUEST);
    const out = await settled(replies, REPLY);
    expect(out.map((m) => m.payload)).toEqual([
      { requestId: 'rq_src', error: PERSIST_SOURCE_REVIEW_ERROR },
    ]);
    expect(persistMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('before the handshake: refused with an error and no call', async () => {
    const replies = await mount({}, { handshake: false });
    postFromBlock('PERSIST_GENERATION_SOURCE', REQUEST);
    const out = await settled(replies, REPLY);
    expect(out.map((m) => m.payload)).toEqual([
      { requestId: 'rq_src', error: PERSIST_SOURCE_NOT_READY_ERROR },
    ]);
    expect(persistMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('with no block token: replied, not dropped', async () => {
    const replies = await mount({ token: undefined } as never);
    postFromBlock('PERSIST_GENERATION_SOURCE', REQUEST);
    const out = await settled(replies, REPLY);
    expect(out.map((m) => m.payload)).toEqual([{ requestId: 'rq_src', error: 'no block token' }]);
    expect(persistMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('an invalid payload with a requestId is replied as an error, with no call', async () => {
    const replies = await mount();
    postFromBlock('PERSIST_GENERATION_SOURCE', { requestId: 'rq_src', workflowId: 'wf_1' });
    const out = await settled(replies, REPLY);
    expect(out.map((m) => m.payload)).toEqual([
      { requestId: 'rq_src', error: PERSIST_SOURCE_INVALID_ERROR },
    ]);
    expect(persistMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a payload with no requestId is dropped — no reply, no call', async () => {
    const replies = await mount();
    postFromBlock('PERSIST_GENERATION_SOURCE', { workflowId: 'wf_1', imageIndex: 0 });
    await new Promise((r) => setTimeout(r, 300));
    expect(replies.of(REPLY)).toHaveLength(0);
    expect(persistMutate).not.toHaveBeenCalled();
    replies.stop();
  });
});
