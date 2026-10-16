import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
import type * as TrpcMod from '~/utils/trpc';
import { APP_REACTION_SERVER_ERRORS } from '~/shared/constants/block-reaction.constants';

/**
 * SET_ENTITY_REACTION / GET_ENTITY_REACTIONS on the PAGE host.
 *
 * The page twin of `IframeHostEntityReaction.browser.test.tsx`; the two hosts share the
 * decision module (`reactionGate.ts`) but not their handlers. Pins that every path replies
 * exactly once, that a missing grant is `needs-consent` with no network call, and — page host
 * only, since the model slot has no review sandbox — that ANY review mode refuses.
 */

const { setMutate, getMutate } = vi.hoisted(() => ({
  setMutate: vi.fn(),
  getMutate: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeInertSubRouter, makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  // The reaction handlers call the wrapper procedures through the VANILLA client
  // (`useUtils().client`), so no render-time hook is added to the host. Every other utils
  // path falls through to the stub's inert helpers.
  const baseUtils = (makeTrpcProxy() as { useUtils: () => object }).useUtils();
  const client = {
    blocks: {
      setReactionFromApp: { mutate: setMutate },
      getReactionsForApp: { mutate: getMutate },
    },
  };
  const utils = new Proxy(baseUtils, {
    get: (target, key) => (key === 'client' ? client : Reflect.get(target, key)),
  });
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    setTrpcBatchingEnabled: vi.fn(),
    trpc: makeTrpcProxy(
      {
        // Nested sub-routers resolve one level deep only, so they need an inert router.
        'apps.shared': makeInertSubRouter(),
        'apps.storage': makeInertSubRouter(),
      },
      { useUtils: () => utils }
    ),
  };
});

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

const SCOPE = 'social:react:self';

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
  blockId: 'gallery-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Gallery',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'gallery-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [SCOPE] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' } as { id: number; username: string | null } | null,
  theme: 'light' as const,
};

async function mount(
  over: Partial<typeof baseProps> & { reviewMode?: boolean } = {},
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

const SET = {
  requestId: 'rq_set',
  entityType: 'image',
  entityId: 9001,
  reaction: 'Laugh',
  reacted: false,
  ticket: 'v1.123.sig',
};
const RESULT = {
  entityType: 'image',
  entityId: 9001,
  changed: true,
  counts: { Like: 0, Heart: 0, Laugh: 2, Cry: 0 },
  viewerReactions: [],
  statsUnknown: false,
};

describe('PageBlockHost SET_ENTITY_REACTION / GET_ENTITY_REACTIONS', () => {
  beforeEach(() => {
    setMutate.mockReset();
    getMutate.mockReset();
  });

  test('calls blocks.setReactionFromApp with the page token and replies the result EXACTLY once', async () => {
    setMutate.mockResolvedValue(RESULT);
    const replies = await mount();
    postFromBlock('SET_ENTITY_REACTION', SET);
    const out = await settled(replies, 'ENTITY_REACTION_RESULT');
    expect(out).toHaveLength(1);
    expect(out[0].payload).toEqual({ requestId: 'rq_set', result: RESULT });
    expectReplyKeys('SET_ENTITY_REACTION', 'success', ['result'], out[0].payload);
    const { requestId: _r, ...forwarded } = SET;
    expect(setMutate).toHaveBeenCalledTimes(1);
    expect(setMutate).toHaveBeenCalledWith({ blockToken: 'tok_abc', ...forwarded });
    replies.stop();
  });

  test('a server scope refusal is reported needs-consent, exactly once', async () => {
    setMutate.mockRejectedValue({
      message: APP_REACTION_SERVER_ERRORS.missingScope,
      data: { code: 'FORBIDDEN' },
    });
    const replies = await mount();
    postFromBlock('SET_ENTITY_REACTION', SET);
    const out = await settled(replies, 'ENTITY_REACTION_RESULT');
    expect(out).toHaveLength(1);
    expect(out[0].payload).toEqual({ requestId: 'rq_set', error: 'needs-consent' });
    expectReplyKeys('SET_ENTITY_REACTION', 'error', ['error'], out[0].payload);
    replies.stop();
  });

  test('🔴 needs-consent: a token WITHOUT the granted scope is refused before any network call', async () => {
    const replies = await mount({ missingScopes: [SCOPE], needsConsent: true });
    postFromBlock('SET_ENTITY_REACTION', SET);
    postFromBlock('GET_ENTITY_REACTIONS', { requestId: 'rq_get', entityType: 'image', ids: [1] });
    const set = await settled(replies, 'ENTITY_REACTION_RESULT');
    const get = await settled(replies, 'ENTITY_REACTIONS_RESULT');
    expect(set.map((m) => m.payload)).toEqual([{ requestId: 'rq_set', error: 'needs-consent' }]);
    expect(get.map((m) => m.payload)).toEqual([{ requestId: 'rq_get', error: 'needs-consent' }]);
    expect(setMutate).not.toHaveBeenCalled();
    expect(getMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('🔴 review-mode: the mod-review sandbox refuses both messages, with no network call', async () => {
    const replies = await mount({ reviewMode: true });
    postFromBlock('SET_ENTITY_REACTION', SET);
    postFromBlock('GET_ENTITY_REACTIONS', { requestId: 'rq_get', entityType: 'image', ids: [1] });
    const set = await settled(replies, 'ENTITY_REACTION_RESULT');
    const get = await settled(replies, 'ENTITY_REACTIONS_RESULT');
    expect(set.map((m) => m.payload)).toEqual([{ requestId: 'rq_set', error: 'review-mode' }]);
    expect(get.map((m) => m.payload)).toEqual([{ requestId: 'rq_get', error: 'review-mode' }]);
    expect(setMutate).not.toHaveBeenCalled();
    expect(getMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('review-mode holds under run-for-real too — the scope is in no review allowlist', async () => {
    const replies = await mount({ reviewMode: true, reviewRunForReal: true } as never);
    postFromBlock('SET_ENTITY_REACTION', SET);
    const out = await settled(replies, 'ENTITY_REACTION_RESULT');
    expect(out.map((m) => m.payload)).toEqual([{ requestId: 'rq_set', error: 'review-mode' }]);
    expect(setMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a signed-out viewer is refused sign-in-required', async () => {
    const replies = await mount({ viewer: null });
    postFromBlock('SET_ENTITY_REACTION', SET);
    const out = await settled(replies, 'ENTITY_REACTION_RESULT');
    expect(out.map((m) => m.payload)).toEqual([{ requestId: 'rq_set', error: 'sign-in-required' }]);
    expect(setMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('before the handshake the host replies not-ready', async () => {
    const replies = await mount({}, { handshake: false });
    postFromBlock('SET_ENTITY_REACTION', SET);
    const out = await settled(replies, 'ENTITY_REACTION_RESULT');
    expect(out.map((m) => m.payload)).toEqual([{ requestId: 'rq_set', error: 'not-ready' }]);
    expect(setMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('with no block token the host replies not-ready instead of dropping the request', async () => {
    const replies = await mount({ token: undefined } as never);
    postFromBlock('SET_ENTITY_REACTION', SET);
    const out = await settled(replies, 'ENTITY_REACTION_RESULT');
    expect(out.map((m) => m.payload)).toEqual([{ requestId: 'rq_set', error: 'not-ready' }]);
    expect(setMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a payload with no requestId is dropped — no reply, no call', async () => {
    const replies = await mount();
    const { requestId: _r, ...noId } = SET;
    postFromBlock('SET_ENTITY_REACTION', noId);
    await new Promise((r) => setTimeout(r, 150));
    expect(replies.of('ENTITY_REACTION_RESULT')).toHaveLength(0);
    expect(setMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('GET_ENTITY_REACTIONS replies the result exactly once', async () => {
    const result = { entityType: 'image', byId: {}, unavailable: [1] };
    getMutate.mockResolvedValue(result);
    const replies = await mount();
    postFromBlock('GET_ENTITY_REACTIONS', { requestId: 'rq_get', entityType: 'image', ids: [1] });
    const out = await settled(replies, 'ENTITY_REACTIONS_RESULT');
    expect(out).toHaveLength(1);
    expect(out[0].payload).toEqual({ requestId: 'rq_get', result });
    expectReplyKeys('GET_ENTITY_REACTIONS', 'success', ['result'], out[0].payload);
    replies.stop();
  });

  test('GET_ENTITY_REACTIONS replies ONE rate-limited error', async () => {
    getMutate.mockRejectedValue({ message: 'x', data: { code: 'TOO_MANY_REQUESTS' } });
    const replies = await mount();
    postFromBlock('GET_ENTITY_REACTIONS', { requestId: 'rq_get', entityType: 'image', ids: [1] });
    const out = await settled(replies, 'ENTITY_REACTIONS_RESULT');
    expect(out).toHaveLength(1);
    expect(out[0].payload).toEqual({ requestId: 'rq_get', error: 'rate-limited' });
    expectReplyKeys('GET_ENTITY_REACTIONS', 'error', ['error'], out[0].payload);
    replies.stop();
  });
});
