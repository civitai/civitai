import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import { makeInertSubRouter, makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * TRACK_EVENT on the model-slot host: the event is queued under the INSTALL's identity, whatever
 * the block puts in its payload, and the block gets no reply.
 */

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 42 }) }));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'blocks.getEffectiveCheckpoint': {
      useQuery: () => ({ data: { checkpoint: null }, isLoading: false }),
    },
    'blocks.getShowcaseImages': { useQuery: () => ({ data: [], isLoading: false }) },
    'apps.shared': makeInertSubRouter(),
    'apps.storage': makeInertSubRouter(),
  }),
}));

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));

// eslint-disable-next-line import/first
import { IframeHost } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import type { BlockInstall, ModelSlotContext } from '~/components/AppBlocks/types';
// eslint-disable-next-line import/first
import { _internalsForTests as events } from '~/components/AppBlocks/blockEventBeacon';
// eslint-disable-next-line import/first
import { _internalsForTests as bridge } from '~/components/AppBlocks/bridgeMessageBeacon';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

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

function listenOnBlock() {
  const received: string[] = [];
  const cw = iframeEl().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: unknown } | null;
    if (d && typeof d.type === 'string') received.push(d.type);
  };
  cw.addEventListener('message', handler);
  return { all: () => [...received], stop: () => cw.removeEventListener('message', handler) };
}

const install: BlockInstall = {
  blockInstanceId: 'mbi_slot_install_1',
  blockId: 'my-model-app',
  appId: 'app_test',
  appBlockId: 'apb_slot',
  manifest: {
    name: 'Slot App',
    scopes: [],
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

async function mountAndReady() {
  renderWithProviders(
    <IframeHost
      install={install}
      context={context}
      token="tok_abc"
      expiresAt={new Date(Date.now() + 15 * 60_000).toISOString()}
    />
  );
  await vi.waitFor(() => {
    if (!iframeEl().contentWindow) throw new Error('not mounted yet');
  });
  const replies = listenOnBlock();
  // Positive control: the listener observes real host pushes, so an empty result below means
  // the host sent nothing rather than that the listener was deaf.
  await vi.waitFor(() => {
    if (!replies.all().includes('BLOCK_INIT')) throw new Error('listener saw no BLOCK_INIT');
  });
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    if (iframeEl().getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
  return replies;
}

let beaconSpy: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  events.reset();
  bridge.reset();
  beaconSpy = vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true);
  fetchSpy = vi.spyOn(window, 'fetch').mockRejectedValue(new Error('no network in tests'));
});
afterEach(() => {
  events.reset();
  bridge.reset();
  beaconSpy.mockRestore();
  fetchSpy.mockRestore();
});

describe('IframeHost forwards TRACK_EVENT', () => {
  test('queues the row under the install identity, ignoring identity in the payload', async () => {
    const replies = await mountAndReady();
    postFromBlock('TRACK_EVENT', {
      eventName: 'generate_clicked',
      properties: { style: 'anime', steps: 20, nested: { a: 1 } },
      appBlockId: 'apb_spoofed',
      blockInstanceId: 'mbi_spoofed',
    });
    await vi.waitFor(() => {
      if (events.queued().length === 0) throw new Error('nothing queued yet');
    });
    expect(events.queued()).toEqual([
      {
        appBlockId: 'apb_slot',
        blockInstanceId: 'mbi_slot_install_1',
        eventName: 'generate_clicked',
        properties: { style: 'anime', steps: 20, nested: { a: 1 } },
      },
    ]);
    replies.stop();
  });

  test('posts no reply to the block', async () => {
    const replies = await mountAndReady();
    const before = replies.all().length;
    postFromBlock('TRACK_EVENT', { eventName: 'opened' });
    // Ordering control: a request the host always answers, posted after the event. Replies
    // arrive in order, so a reply the TRACK_EVENT handler sends synchronously lands first.
    postFromBlock('REQUEST_TOKEN', { requestId: 'rq_order' });
    await vi.waitFor(() => {
      if (!replies.all().slice(before).includes('TOKEN_REFRESH_RESPONSE')) {
        throw new Error('no control reply');
      }
    });
    expect(events.queued()).toHaveLength(1);
    expect(replies.all().slice(before)).toEqual(['TOKEN_REFRESH_RESPONSE']);
    replies.stop();
  });

  test('counts the message as handled on the bridge counter', async () => {
    const replies = await mountAndReady();
    postFromBlock('TRACK_EVENT', { eventName: 'opened' });
    await vi.waitFor(() => {
      if (!bridge.buffered().some((r) => r.type === 'TRACK_EVENT')) throw new Error('not counted');
    });
    const rows = bridge.buffered().filter((r) => r.type === 'TRACK_EVENT');
    expect(rows).toEqual([
      {
        appBlockId: 'apb_slot',
        type: 'TRACK_EVENT',
        host: 'IframeHost',
        outcome: 'handled',
        count: 1,
      },
    ]);
    replies.stop();
  });
});
