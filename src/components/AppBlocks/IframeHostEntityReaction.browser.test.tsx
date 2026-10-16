import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
import type * as TrpcMod from '~/utils/trpc';
import { APP_REACTION_SERVER_ERRORS } from '~/shared/constants/block-reaction.constants';

/**
 * SET_ENTITY_REACTION / GET_ENTITY_REACTIONS on the MODEL-SLOT host.
 *
 * The decision layer is shared with the page host (`reactionGate.ts`, unit-tested on its own);
 * these pin THIS host's wiring: that it calls the wrapper procedures with its own token, that
 * every path replies EXACTLY once, and that a missing consent grant is refused before any
 * network call. Mirrored by `PageBlockHostEntityReaction.browser.test.tsx` — the two hosts
 * share no handlers, so neither suite can see the other's.
 *
 * There is no mod-review sandbox on the model slot, so `review-mode` is unreachable here; it is
 * pinned on the page host.
 */

const { setMutate, getMutate, currentUser } = vi.hoisted(() => ({
  setMutate: vi.fn(),
  getMutate: vi.fn(),
  currentUser: { value: null as { id: number } | null },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => currentUser.value }));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
}));

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
    trpc: makeTrpcProxy(
      {
        // Nested sub-routers resolve one level deep only, so they need an inert router.
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
const SCOPE = 'social:react:self';

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
      name: 'Gallery',
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
  reaction: 'Heart',
  reacted: true,
  ticket: 'v1.123.sig',
};
const RESULT = {
  entityType: 'image',
  entityId: 9001,
  changed: true,
  counts: { Like: 0, Heart: 1, Laugh: 0, Cry: 0 },
  viewerReactions: ['Heart'],
  statsUnknown: false,
};

describe('IframeHost SET_ENTITY_REACTION / GET_ENTITY_REACTIONS', () => {
  beforeEach(() => {
    setMutate.mockReset();
    getMutate.mockReset();
    currentUser.value = { id: 42 };
  });

  test('calls blocks.setReactionFromApp with the host token and replies the result EXACTLY once', async () => {
    setMutate.mockResolvedValue(RESULT);
    const replies = await mount();
    postFromBlock('SET_ENTITY_REACTION', SET);
    const out = await settled(replies, 'ENTITY_REACTION_RESULT');
    expect(out).toHaveLength(1);
    expect(out[0].payload).toEqual({ requestId: 'rq_set', result: RESULT });
    expectReplyKeys('SET_ENTITY_REACTION', 'success', ['result'], out[0].payload);
    // No per-tap confirm: straight to the server, with this host's token and nothing extra.
    expect(setMutate).toHaveBeenCalledTimes(1);
    const { requestId: _r, ...forwarded } = SET;
    expect(setMutate).toHaveBeenCalledWith({ blockToken: 'tok_abc', ...forwarded });
    replies.stop();
  });

  test('a server refusal replies ONE closed-set error — the ticket guard reads entity-unavailable', async () => {
    setMutate.mockRejectedValue({
      message: APP_REACTION_SERVER_ERRORS.ticket,
      data: { code: 'FORBIDDEN' },
    });
    const replies = await mount();
    postFromBlock('SET_ENTITY_REACTION', SET);
    const out = await settled(replies, 'ENTITY_REACTION_RESULT');
    expect(out).toHaveLength(1);
    expect(out[0].payload).toEqual({ requestId: 'rq_set', error: 'entity-unavailable' });
    expectReplyKeys('SET_ENTITY_REACTION', 'error', ['error'], out[0].payload);
    replies.stop();
  });

  test('a rate-limited server answer replies rate-limited', async () => {
    setMutate.mockRejectedValue({ message: 'x', data: { code: 'TOO_MANY_REQUESTS' } });
    const replies = await mount();
    postFromBlock('SET_ENTITY_REACTION', SET);
    const out = await settled(replies, 'ENTITY_REACTION_RESULT');
    expect(out.map((m) => m.payload)).toEqual([{ requestId: 'rq_set', error: 'rate-limited' }]);
    replies.stop();
  });

  test('🔴 needs-consent: a token WITHOUT the granted scope is refused before any network call', async () => {
    const replies = await mount({ missingScopes: [SCOPE] });
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

  test('an anonymous viewer is refused sign-in-required, with no network call', async () => {
    currentUser.value = null;
    const replies = await mount();
    postFromBlock('SET_ENTITY_REACTION', SET);
    const out = await settled(replies, 'ENTITY_REACTION_RESULT');
    expect(out.map((m) => m.payload)).toEqual([{ requestId: 'rq_set', error: 'sign-in-required' }]);
    expect(setMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('before the handshake the host replies not-ready', async () => {
    const replies = await mount({ handshake: false });
    postFromBlock('SET_ENTITY_REACTION', SET);
    const out = await settled(replies, 'ENTITY_REACTION_RESULT');
    expect(out.map((m) => m.payload)).toEqual([{ requestId: 'rq_set', error: 'not-ready' }]);
    expect(setMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('Dislike is refused invalid-request on the host, before the server is asked', async () => {
    const replies = await mount();
    postFromBlock('SET_ENTITY_REACTION', { ...SET, reaction: 'Dislike' });
    const out = await settled(replies, 'ENTITY_REACTION_RESULT');
    expect(out.map((m) => m.payload)).toEqual([{ requestId: 'rq_set', error: 'invalid-request' }]);
    expect(setMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('GET_ENTITY_REACTIONS forwards ids and tickets and replies the result exactly once', async () => {
    const result = { entityType: 'image', byId: {}, unavailable: [1] };
    getMutate.mockResolvedValue(result);
    const replies = await mount();
    postFromBlock('GET_ENTITY_REACTIONS', {
      requestId: 'rq_get',
      entityType: 'image',
      ids: [1],
      tickets: { '1': 't1' },
    });
    const out = await settled(replies, 'ENTITY_REACTIONS_RESULT');
    expect(out).toHaveLength(1);
    expect(out[0].payload).toEqual({ requestId: 'rq_get', result });
    expectReplyKeys('GET_ENTITY_REACTIONS', 'success', ['result'], out[0].payload);
    expect(getMutate).toHaveBeenCalledWith({
      blockToken: 'tok_abc',
      entityType: 'image',
      ids: [1],
      tickets: { '1': 't1' },
    });
    replies.stop();
  });

  test('GET_ENTITY_REACTIONS replies ONE error when the server refuses', async () => {
    getMutate.mockRejectedValue({ message: 'x', data: { code: 'UNAUTHORIZED' } });
    const replies = await mount();
    postFromBlock('GET_ENTITY_REACTIONS', { requestId: 'rq_get', entityType: 'image', ids: [1] });
    const out = await settled(replies, 'ENTITY_REACTIONS_RESULT');
    expect(out).toHaveLength(1);
    expect(out[0].payload).toEqual({ requestId: 'rq_get', error: 'sign-in-required' });
    expectReplyKeys('GET_ENTITY_REACTIONS', 'error', ['error'], out[0].payload);
    replies.stop();
  });
});
