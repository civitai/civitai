import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import { resetDailyLimitRaiseSuppression } from '~/components/AppBlocks/openDailyLimitRaise';
import type * as TrpcMod from '~/utils/trpc';

/**
 * The in-app daily-limit raise on the MODEL-SLOT host, which has no daily-limit dialog of its own:
 * a relayed submit refused at the limit opens the raise dialog, and the app's own request is
 * answered with the same two replies as on the page host.
 */

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  readLimit: vi.fn(),
  currentUser: { value: { id: 42 } as { id: number } | null },
  raiseFlagOn: true,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser.value }));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({
    appBlocks: false,
    appBlocksPages: false,
    appDailyLimitRaise: mocks.raiseFlagOn,
  }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeInertSubRouter, makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  const baseUtils = (makeTrpcProxy() as { useUtils: () => Record<string, unknown> }).useUtils();
  const blocksUtils = {
    getMyAppDailyLimit: { fetch: mocks.readLimit, invalidate: vi.fn(async () => undefined) },
  };
  const utils = new Proxy(baseUtils, {
    get: (target, key) =>
      key === 'blocks'
        ? new Proxy(Reflect.get(target, key) as object, {
            get: (t, k) => (k in blocksUtils ? blocksUtils[k as never] : Reflect.get(t, k)),
          })
        : Reflect.get(target, key),
  });
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'apps.shared': makeInertSubRouter(),
        'apps.storage': makeInertSubRouter(),
        'blocks.getEffectiveCheckpoint': {
          useQuery: () => ({ data: { checkpoint: null }, isLoading: false }),
        },
        'blocks.getShowcaseImages': { useQuery: () => ({ data: [], isLoading: false }) },
        'blocks.submitWorkflow': { useMutation: () => ({ mutateAsync: mocks.submit }) },
      },
      { useUtils: () => utils }
    ),
  };
});

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));

// eslint-disable-next-line import/first
import { IframeHost } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import type { BlockInstall, ModelSlotContext } from '~/components/AppBlocks/types';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;
const SCOPE = 'ai:write:budgeted';

function iframeEl() {
  return page.getByTestId('block-iframe').element() as HTMLIFrameElement;
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

function installWith(scopes: string[]): BlockInstall {
  return {
    blockInstanceId: 'inst_test',
    blockId: 'my-model-app',
    appId: 'app_test',
    appBlockId: 'apb_test',
    manifest: {
      name: 'Slot Gen',
      scopes,
      iframe: {
        src: SAME_ORIGIN_SRC,
        minHeight: 200,
        maxHeight: 800,
        resizable: true,
        sandbox: 'allow-scripts',
      },
    },
    publisherSettings: {},
    enabled: true,
    renderMode: 'iframe',
    trustTier: 'internal',
  };
}

const context: ModelSlotContext = {
  slotId: 'model.sidebar_top',
  entityType: 'model',
  modelId: 123,
  modelVersionId: 456,
  modelName: 'Some Model',
  modelType: 'Checkpoint',
  modelNsfwLevel: 1,
  creatorUserId: 7,
  viewerUserId: 42,
  viewerNsfwEnabled: false,
  viewerUsername: 'tester',
  theme: 'light',
};

async function mount(
  opts: { missingScopes?: string[]; handshake?: boolean } = {}
): Promise<ReturnType<typeof listenForReply>> {
  renderWithProviders(
    <IframeHost
      install={installWith([SCOPE])}
      context={context}
      token="tok_abc"
      expiresAt={new Date(Date.now() + 15 * 60_000).toISOString()}
      missingScopes={opts.missingScopes ?? []}
    />
  );
  await vi.waitFor(() => {
    if (!iframeEl().contentWindow) throw new Error('not mounted yet');
  });
  const replies = listenForReply();
  // POSITIVE CONTROL: the listener observes real host pushes before any assertion rests on it.
  await vi.waitFor(() => {
    if (replies.of('BLOCK_INIT').length === 0) throw new Error('listener saw no BLOCK_INIT');
  });
  if (opts.handshake !== false) {
    await vi.waitFor(() => {
      postFromBlock('BLOCK_READY', {});
      if (iframeEl().getAttribute('data-block-ready') !== 'true') throw new Error('not ready');
    });
  }
  return replies;
}

const REFUSED = {
  workflowId: 'failed',
  status: 'failed',
  error: 'app Buzz limit reached',
  errorCode: 'daily-limit-exceeded',
};
const LIMIT = { limit: 1000, spentToday: 980, refusedRecently: false };

function hasId(payload: unknown, requestId: string) {
  return (payload as { requestId?: string }).requestId === requestId;
}

async function reply(replies: ReturnType<typeof listenForReply>, type: string, requestId: string) {
  await vi.waitFor(() => {
    if (!replies.of(type).some((m) => hasId(m.payload, requestId))) throw new Error(`no ${type}`);
  });
  return replies.of(type).find((m) => hasId(m.payload, requestId))!.payload as Record<
    string,
    unknown
  >;
}

function raiseDialogs() {
  return useDialogStore
    .getState()
    .dialogs.filter((d) => String(d.id).startsWith('block-daily-limit-')) as unknown as Array<{
    props: { limit: number; spentToday: number; onRaised?: () => void };
    options?: { onClose?: () => void };
  }>;
}

describe('IframeHost in-app daily-limit raise', () => {
  beforeEach(() => {
    mocks.submit.mockReset();
    mocks.readLimit.mockReset();
    mocks.raiseFlagOn = true;
    useDialogStore.getState().closeAll();
    resetDailyLimitRaiseSuppression();
  });

  test('a refused submit opens the raise dialog; the request then reports the raise', async () => {
    mocks.submit.mockResolvedValue({ snapshot: REFUSED });
    mocks.readLimit.mockResolvedValue(LIMIT);
    const replies = await mount();
    postFromBlock('SUBMIT_WORKFLOW', { requestId: 'rq_sub', body: {} });
    await reply(replies, 'WORKFLOW_SUBMITTED', 'rq_sub');
    await vi.waitFor(() => expect(raiseDialogs()).toHaveLength(1));
    expect(raiseDialogs()[0].props).toMatchObject({ limit: 1000, spentToday: 980 });
    raiseDialogs()[0].options?.onClose?.();
    useDialogStore.getState().closeAll();
    resetDailyLimitRaiseSuppression();

    postFromBlock('REQUEST_DAILY_LIMIT_RAISE', { requestId: 'rq_raise' });
    expect(await reply(replies, 'DAILY_LIMIT_RAISE_ACK', 'rq_raise')).toMatchObject({
      opened: true,
    });
    await vi.waitFor(() => expect(raiseDialogs()).toHaveLength(1));
    const d = raiseDialogs()[0];
    d.props.onRaised?.();
    d.options?.onClose?.();
    const result = await reply(replies, 'DAILY_LIMIT_RAISE_RESULT', 'rq_raise');
    expectReplyKeys('REQUEST_DAILY_LIMIT_RAISE', 'success', ['raised'], result);
    expect(result).toMatchObject({ raised: true });
  });

  test("the app's request alone opens nothing", async () => {
    mocks.readLimit.mockResolvedValue(LIMIT);
    const replies = await mount();
    postFromBlock('REQUEST_DAILY_LIMIT_RAISE', { requestId: 'rq_ask' });
    expect(await reply(replies, 'DAILY_LIMIT_RAISE_ACK', 'rq_ask')).toMatchObject({
      opened: false,
    });
    const result = await reply(replies, 'DAILY_LIMIT_RAISE_RESULT', 'rq_ask');
    expectReplyKeys('REQUEST_DAILY_LIMIT_RAISE', 'success', ['raised'], result);
    expect(result).toMatchObject({ raised: false });
    expect(raiseDialogs()).toHaveLength(0);
  });
});
