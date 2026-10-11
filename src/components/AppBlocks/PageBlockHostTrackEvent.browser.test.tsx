import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import { makeInertSubRouter, makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * TRACK_EVENT on the page host: the event is queued as `page_<appBlockId>` of the host's own app,
 * whatever the block puts in its payload; the block gets no reply; a review preview forwards
 * nothing.
 */

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  setTrpcBatchingEnabled: vi.fn(),
  trpc: makeTrpcProxy({
    'apps.shared': makeInertSubRouter(),
    'apps.storage': makeInertSubRouter(),
  }),
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
// eslint-disable-next-line import/first
import { _internalsForTests as events } from '~/components/AppBlocks/blockEventBeacon';
// eslint-disable-next-line import/first
import { _internalsForTests as bridge } from '~/components/AppBlocks/bridgeMessageBeacon';

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

const baseProps = {
  appBlockId: 'apb_page',
  blockId: 'page-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_page',
  appName: 'Page App',
  iframeSrc: `${window.location.origin}/`,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'page-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' } as { id: number; username: string | null } | null,
  theme: 'light' as const,
};

async function mountAndReady(over: { reviewMode?: boolean } = {}) {
  renderWithProviders(<PageBlockHost {...baseProps} {...over} />);
  await vi.waitFor(() => {
    if (!iframeEl().contentWindow) throw new Error('not mounted yet');
  });
  const replies = listenOnBlock();
  // Positive control: the listener observes real host pushes.
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
beforeEach(() => {
  events.reset();
  bridge.reset();
  beaconSpy = vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true);
});
afterEach(() => {
  events.reset();
  bridge.reset();
  beaconSpy.mockRestore();
});

describe('PageBlockHost forwards TRACK_EVENT', () => {
  test('queues the row as the page instance of its own app, ignoring identity in the payload', async () => {
    const replies = await mountAndReady();
    postFromBlock('TRACK_EVENT', {
      eventName: 'run_started',
      properties: { mode: 'fast', count: 3, ok: true, list: [1] },
      appBlockId: 'apb_spoofed',
      blockInstanceId: 'page_apb_spoofed',
    });
    await vi.waitFor(() => {
      if (events.queued().length === 0) throw new Error('nothing queued yet');
    });
    expect(events.queued()).toEqual([
      {
        appBlockId: 'apb_page',
        blockInstanceId: 'page_apb_page',
        eventName: 'run_started',
        properties: { mode: 'fast', count: 3, ok: true },
      },
    ]);
    replies.stop();
  });

  test('posts no reply to the block', async () => {
    const replies = await mountAndReady();
    const before = replies.all().length;
    postFromBlock('TRACK_EVENT', { eventName: 'opened' });
    await vi.waitFor(() => {
      if (events.queued().length === 0) throw new Error('nothing queued yet');
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(replies.all().slice(before)).toEqual([]);
    replies.stop();
  });

  test('counts the message as handled on the bridge counter', async () => {
    const replies = await mountAndReady();
    postFromBlock('TRACK_EVENT', { eventName: 'opened' });
    await vi.waitFor(() => {
      if (!bridge.buffered().some((r) => r.type === 'TRACK_EVENT')) throw new Error('not counted');
    });
    expect(bridge.buffered().filter((r) => r.type === 'TRACK_EVENT')).toEqual([
      {
        appBlockId: 'apb_page',
        type: 'TRACK_EVENT',
        host: 'PageBlockHost',
        outcome: 'handled',
        count: 1,
      },
    ]);
    replies.stop();
  });

  test('a review preview forwards nothing', async () => {
    const replies = await mountAndReady({ reviewMode: true });
    postFromBlock('TRACK_EVENT', { eventName: 'opened' });
    // The dispatcher has delivered the message once it is counted.
    await vi.waitFor(() => {
      if (!bridge.buffered().some((r) => r.type === 'TRACK_EVENT')) throw new Error('not counted');
    });
    expect(events.queued()).toEqual([]);
    replies.stop();
  });
});
