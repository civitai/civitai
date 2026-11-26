import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import type * as TrpcMod from '~/utils/trpc';

/**
 * REQUEST_OUTPUT_UNLOCK on the MODEL-SLOT host: the same bridge as the page host
 * (`useOutputUnlockBridge`), answered with the same OUTPUT_UNLOCK_RESULT { result }.
 */

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  unlock: vi.fn(),
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeInertSubRouter, makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  const baseUtils = (makeTrpcProxy() as { useUtils: () => Record<string, unknown> }).useUtils();
  const client = {
    blocks: {
      previewOutputUnlock: { mutate: mocks.preview },
      unlockOutput: { mutate: mocks.unlock },
    },
  };
  const utils = new Proxy(baseUtils, {
    get: (target, key) => (key === 'client' ? client : Reflect.get(target, key)),
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
const WF = '42-20261115120000000';

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
  cw.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  });
  return { of: (type: string) => received.filter((m) => m.type === type) };
}

const install: BlockInstall = {
  blockInstanceId: 'inst_test',
  blockId: 'my-model-app',
  appId: 'app_test',
  appBlockId: 'apb_test',
  manifest: {
    name: 'Slot Gen',
    scopes: ['ai:write:budgeted'],
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

async function mount() {
  renderWithProviders(
    <IframeHost
      install={install}
      context={context}
      token="tok_abc"
      expiresAt={new Date(Date.now() + 15 * 60_000).toISOString()}
      missingScopes={[]}
    />,
    { user: { id: 42 } }
  );
  await vi.waitFor(() => {
    if (!iframeEl().contentWindow) throw new Error('not mounted yet');
  });
  const replies = listenForReply();
  // POSITIVE CONTROL: the listener observes real host pushes before any assertion rests on it.
  await vi.waitFor(() => {
    if (replies.of('BLOCK_INIT').length === 0) throw new Error('listener saw no BLOCK_INIT');
  });
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    if (iframeEl().getAttribute('data-block-ready') !== 'true') throw new Error('not ready');
  });
  return replies;
}

async function resultFor(replies: ReturnType<typeof listenForReply>, requestId: string) {
  await vi.waitFor(() => {
    const got = replies
      .of('OUTPUT_UNLOCK_RESULT')
      .some((m) => (m.payload as { requestId?: string }).requestId === requestId);
    if (!got) throw new Error(`no OUTPUT_UNLOCK_RESULT for ${requestId}`);
  });
  return replies
    .of('OUTPUT_UNLOCK_RESULT')
    .find((m) => (m.payload as { requestId?: string }).requestId === requestId)!.payload as {
    requestId: string;
    result: Record<string, unknown>;
  };
}

type UnlockDialog = {
  props: {
    unlock: (expectedTotal: number) => Promise<Record<string, unknown>>;
    onResult: (r: unknown) => void;
  };
  options?: { onClose?: () => void };
};

function unlockDialogs() {
  return useDialogStore
    .getState()
    .dialogs.filter((d) =>
      String(d.id).startsWith('block-output-unlock-')
    ) as unknown as UnlockDialog[];
}

describe('IframeHost REQUEST_OUTPUT_UNLOCK', () => {
  beforeEach(() => {
    mocks.preview.mockReset();
    mocks.unlock.mockReset();
    useDialogStore.getState().closeAll();
  });

  test('pay: the confirmed unlock runs at the previewed total and the snapshot is relayed', async () => {
    const snapshot = {
      workflowId: WF,
      status: 'succeeded',
      outputs: [{ url: 'https://cdn/r.png' }],
    };
    mocks.preview.mockResolvedValue({
      kind: 'pay',
      position: 0,
      unlockBuzz: 90,
    });
    mocks.unlock.mockResolvedValue({ outcome: 'unlocked', snapshot });
    const replies = await mount();
    postFromBlock('REQUEST_OUTPUT_UNLOCK', { requestId: 'rq_slot', workflowId: WF, position: 0 });
    await vi.waitFor(() => expect(unlockDialogs()).toHaveLength(1));
    const dialog = unlockDialogs()[0];
    dialog.props.onResult(await dialog.props.unlock(90));
    expect(mocks.unlock).toHaveBeenCalledWith({
      blockToken: 'tok_abc',
      workflowId: WF,
      position: 0,
      expectedTotal: 90,
    });
    dialog.options?.onClose?.();
    const payload = await resultFor(replies, 'rq_slot');
    expect(payload.result).toEqual({ outcome: 'unlocked', snapshot });
    expectReplyKeys('REQUEST_OUTPUT_UNLOCK', 'success', ['result'], payload);
  });

  test('unavailable (the viewer settings case) is relayed with the server message when closed', async () => {
    mocks.preview.mockResolvedValue({
      kind: 'unavailable',
      position: 0,
      message: 'This output is above your browsing level.',
    });
    const replies = await mount();
    postFromBlock('REQUEST_OUTPUT_UNLOCK', { requestId: 'rq_set', workflowId: WF, position: 0 });
    await vi.waitFor(() => expect(unlockDialogs()).toHaveLength(1));
    unlockDialogs()[0].options?.onClose?.();
    expect((await resultFor(replies, 'rq_set')).result).toEqual({
      outcome: 'unavailable',
      message: 'This output is above your browsing level.',
    });
    expect(mocks.unlock).not.toHaveBeenCalled();
  });
});
