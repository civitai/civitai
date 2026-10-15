import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
// Type-only namespace import for the `importOriginal` spread below.
import type * as TrpcMod from '~/utils/trpc';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import type { GenerationResource } from '~/shared/types/generation.types';

/**
 * Replies the model-slot host (IframeHost) writes itself, captured for the reply-key ledger in
 * `hostHandlerParity.test.ts`.
 *
 * - SET_USER_CHECKPOINT → USER_CHECKPOINT_SET. Only this host can persist the override,
 *   because the settings row is keyed by a model-bound install.
 * - OPEN_CHECKPOINT_PICKER → CHECKPOINT_PICKER_RESULT, which this host answers with its own
 *   handler.
 * - ESTIMATE_WORKFLOW_BATCH → ESTIMATE_BATCH_RESULT with no credential. The shared batch
 *   handler hands that case back to the host, and this host writes the error reply inline.
 */

const { updateSettings, refetchCheckpoint } = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  refetchCheckpoint: vi.fn(),
}));

const rpc = await vi.hoisted(async () => {
  const { createBridgeRpcMock } = await import('../../../test/bridgeRpcMock');
  return createBridgeRpcMock({
    'blocks.getEffectiveCheckpoint': {
      useQuery: () => ({
        data: { checkpoint: null },
        isLoading: false,
        refetch: refetchCheckpoint,
      }),
    },
    'blocks.getShowcaseImages': { useQuery: () => ({ data: [], isLoading: false }) },
    'blocks.updateUserSettings': { useMutation: () => ({ mutateAsync: updateSettings }) },
  });
});

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// Replaces the module, so it names every export this file's graph imports. If one is missing,
// the FILE fails to import, and that reports as "no tests" instead of as a failure.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: rpc.trpc,
}));

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));

// eslint-disable-next-line import/first
import { IframeHost } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import type { BlockInstall, ModelSlotContext } from '~/components/AppBlocks/types';

const install: BlockInstall = {
  blockInstanceId: 'inst_test',
  blockId: 'my-model-app',
  appId: 'app_test',
  appBlockId: 'apb_test',
  manifest: {
    name: 'Slot App',
    scopes: [],
    iframe: {
      src: `${window.location.origin}/`,
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

function iframeEl() {
  return page.getByTestId('block-iframe').element() as HTMLIFrameElement;
}

function post(type: string, payload: unknown) {
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

function listen() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const cw = iframeEl().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    // Re-clone into THIS realm so `toEqual` compares plain objects.
    if (d && typeof d.type === 'string') {
      received.push({ type: d.type, payload: structuredClone(d.payload) });
    }
  };
  cw.addEventListener('message', handler);
  return {
    of: (type: string) => received.filter((m) => m.type === type),
    stop: () => cw.removeEventListener('message', handler),
  };
}

async function mountAndReady(token = 'tok_abc') {
  renderWithProviders(
    <IframeHost
      install={install}
      context={context}
      token={token}
      expiresAt={new Date(Date.now() + 15 * 60_000).toISOString()}
    />
  );
  await vi.waitFor(() => {
    if (!iframeEl().contentWindow) throw new Error('not mounted yet');
  });
  await vi.waitFor(() => {
    post('BLOCK_READY', {});
    if (iframeEl().getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

describe('IframeHost SET_USER_CHECKPOINT → USER_CHECKPOINT_SET', () => {
  test('persists the override, refetches the effective checkpoint and replies { ok: true }', async () => {
    updateSettings.mockReset().mockResolvedValue(undefined);
    refetchCheckpoint.mockReset();
    await mountAndReady();
    const replies = listen();

    post('SET_USER_CHECKPOINT', { requestId: 'rq_set', versionId: 9001 });

    await vi.waitFor(() => expect(replies.of('USER_CHECKPOINT_SET')).toHaveLength(1));
    const [reply] = replies.of('USER_CHECKPOINT_SET');
    expect(reply.payload).toEqual({ requestId: 'rq_set', ok: true });
    expectReplyKeys('SET_USER_CHECKPOINT', 'success', ['ok'], reply.payload);
    expect(updateSettings).toHaveBeenCalledWith({
      blockToken: 'tok_abc',
      settings: { checkpoint_version_id: 9001 },
    });
    expect(refetchCheckpoint).toHaveBeenCalledTimes(1);
    replies.stop();
  });

  test('a non-numeric versionId is refused with { ok: false, error } and nothing is written', async () => {
    updateSettings.mockReset();
    await mountAndReady();
    const replies = listen();

    post('SET_USER_CHECKPOINT', { requestId: 'rq_bad', versionId: 'nine' });

    await vi.waitFor(() => expect(replies.of('USER_CHECKPOINT_SET')).toHaveLength(1));
    const [reply] = replies.of('USER_CHECKPOINT_SET');
    expect(reply.payload).toEqual({
      requestId: 'rq_bad',
      ok: false,
      error: 'versionId must be a number or null',
    });
    expectReplyKeys('SET_USER_CHECKPOINT', 'error', ['error', 'ok'], reply.payload);
    expect(updateSettings).not.toHaveBeenCalled();
    replies.stop();
  });
});

function lastResourceModalProps(): ResourceSelectModalProps {
  const dialogs = useDialogStore.getState().dialogs;
  if (dialogs.length === 0) throw new Error('no resource-select modal opened');
  return dialogs[dialogs.length - 1].props as unknown as ResourceSelectModalProps;
}

describe('IframeHost OPEN_CHECKPOINT_PICKER → CHECKPOINT_PICKER_RESULT', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
  });

  test('a pick replies { selected } with the five-field projection', async () => {
    await mountAndReady();
    const replies = listen();

    post('OPEN_CHECKPOINT_PICKER', { requestId: 'rq_pick' });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    lastResourceModalProps().onSelect({
      id: 9001,
      name: 'v1.0',
      baseModel: 'Flux.1 D',
      model: { id: 700, name: 'My Checkpoint', type: 'Checkpoint' },
    } as unknown as GenerationResource);

    await vi.waitFor(() => expect(replies.of('CHECKPOINT_PICKER_RESULT')).toHaveLength(1));
    const [reply] = replies.of('CHECKPOINT_PICKER_RESULT');
    expect(reply.payload).toEqual({
      requestId: 'rq_pick',
      selected: {
        versionId: 9001,
        modelId: 700,
        modelName: 'My Checkpoint',
        versionName: 'v1.0',
        baseModel: 'Flux.1 D',
      },
    });
    expectReplyKeys('OPEN_CHECKPOINT_PICKER', 'success', ['selected'], reply.payload);
    replies.stop();
  });

  test('a dismiss without a pick replies a bare { requestId }', async () => {
    await mountAndReady();
    const replies = listen();

    post('OPEN_CHECKPOINT_PICKER', { requestId: 'rq_cancel' });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    lastResourceModalProps().onClose?.();

    await vi.waitFor(() => expect(replies.of('CHECKPOINT_PICKER_RESULT')).toHaveLength(1));
    const [reply] = replies.of('CHECKPOINT_PICKER_RESULT');
    expect(reply.payload).toEqual({ requestId: 'rq_cancel' });
    expectReplyKeys('OPEN_CHECKPOINT_PICKER', 'success', [], reply.payload);
    replies.stop();
  });
});

describe('IframeHost ESTIMATE_WORKFLOW_BATCH → ESTIMATE_BATCH_RESULT', () => {
  test('with no block credential it replies a bare { error }', async () => {
    await mountAndReady('');
    const replies = listen();

    post('ESTIMATE_WORKFLOW_BATCH', {
      requestId: 'rq_batch',
      bodies: [{ kind: 'textToImage', modelId: 7, modelVersionId: 99, params: { prompt: 'a' } }],
    });

    await vi.waitFor(() => expect(replies.of('ESTIMATE_BATCH_RESULT')).toHaveLength(1));
    const [reply] = replies.of('ESTIMATE_BATCH_RESULT');
    expect(reply.payload).toEqual({ requestId: 'rq_batch', error: 'block credential unavailable' });
    expectReplyKeys('ESTIMATE_WORKFLOW_BATCH', 'error', ['error'], reply.payload);
    replies.stop();
  });
});
