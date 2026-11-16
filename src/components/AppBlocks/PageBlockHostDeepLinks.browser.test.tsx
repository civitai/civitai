// The scaffold's `next/router` mock exports ONE router singleton as `default`,
// `Router` and the `useRouter()` return value alike (see PageBlockHostNavigate).
import Router from 'next/router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
import type * as TrpcModule from '~/utils/trpc';

/**
 * Deep links into app state, the share link, and back/forward — the HOST-INTEGRATION half.
 * The pure rules are unit-tested in `__tests__/deepLinkLogic.test.ts`; this file mounts the
 * REAL `PageBlockHost` and drives the REAL postMessage bridge.
 *
 *  1. BLOCK_INIT.context and ROUTE_CHANGED carry `search` and `hash` from `router.asPath`
 *     (host-owned `from`, `sl` and `src` stripped).
 *  2. A router move — what Next does on popstate (back/forward) — delivers ROUTE_CHANGED,
 *     including a move that changes ONLY the search or the hash.
 *  3. NAVIGATE: app scope pushes a history entry (with `scroll: false`); `replace: true`
 *     replaces instead; a navigate to the URL already showing pushes nothing, judged against
 *     the href the host last moved to, not a stale `router.asPath`.
 *  4. SHARE_LINK → SHARE_LINK_RESULT with the canonical URL, copied only when the
 *     clipboard write resolved AND the app's frame has focus, refusals for escapes, and a
 *     rate limit.
 *
 * ⚠️ WHAT THIS FILE CANNOT SEE: the `next/router` mock is a static object, so there is no
 * real history stack. "Back returns to the gallery" depends on Next's own popstate handler
 * updating `router.query`/`router.asPath`; here that update is simulated by mutating the
 * mock and re-rendering. The real back/forward path is a manual check (the Live Characters
 * builder seat), stated in the PR. Likewise a driven MessageEvent carries no user
 * activation, so `navigator.userActivation` is stubbed.
 */

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  // eslint-disable-next-line local-rules/no-hand-enumerated-trpc-mock -- same literal as PageBlockHostNavigate / InitContractV2: the inert proxy fails every test here (PageBlockHost reads hook shapes at render)
  trpc: {
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
      previewPostFromApp: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      createPostFromApp: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getImagesByIds: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getWorkflowMedia: { useMutation: () => ({ mutateAsync: vi.fn() }) },
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

type MutableRouter = { asPath: string; query: Record<string, unknown> };
const router = Router;
// The same singleton, viewed as the mutable fields a test moves (what Next does on popstate).
const routerState = Router as unknown as MutableRouter;
const pushMock = () => router.push as unknown as ReturnType<typeof vi.fn>;
const replaceMock = () => router.replace as unknown as ReturnType<typeof vi.fn>;
const writeTextMock = () => navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;

const SLUG = 'live-characters';
const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const baseProps = {
  appBlockId: 'apb_heron_4410',
  blockId: SLUG,
  appId: 'app_quartz_2291',
  blockInstanceId: 'page_apb_heron_4410',
  appName: 'Live Characters',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: SLUG,
  token: 'tok_pelican_7720',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: null,
  theme: 'light' as const,
};

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

function listenForHostPosts() {
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
    last: (type: string) => [...received].reverse().find((m) => m.type === type),
    stop: () => cw.removeEventListener('message', handler),
  };
}

async function waitMounted() {
  await vi.waitFor(() => {
    if (!iframeEl().contentWindow) throw new Error('not mounted yet');
  });
}

async function driveToReady() {
  await waitMounted();
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    if (iframeEl().getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

/** Let queued postMessages land, so a count read afterwards is settled. */
const settle = () => new Promise((r) => setTimeout(r, 60));

type BridgeLocation = { subPath: string; search: string; hash: string };

/**
 * ROUTE_CHANGED messages whose payload IS `loc`, from the `since`-th one on. Counting by
 * payload, not a total, so a ROUTE_CHANGED for another location (the one sent at ready,
 * which may land after the listener is attached) cannot move the count.
 */
function routeChangedTo(
  posts: ReturnType<typeof listenForHostPosts>,
  loc: BridgeLocation,
  since = 0
): number {
  return posts
    .of('ROUTE_CHANGED')
    .slice(since)
    .filter((m) => {
      const p = m.payload as Partial<BridgeLocation> | undefined;
      return p?.subPath === loc.subPath && p?.search === loc.search && p?.hash === loc.hash;
    }).length;
}

/** Wait for exactly one ROUTE_CHANGED to `loc` (after `since`), and no burst after it. */
async function expectOneRouteChangedTo(
  posts: ReturnType<typeof listenForHostPosts>,
  loc: BridgeLocation,
  since = 0
) {
  await vi.waitFor(() => expect(routeChangedTo(posts, loc, since)).toBeGreaterThan(0));
  await settle();
  expect(routeChangedTo(posts, loc, since)).toBe(1);
}

/** Give the app's frame focus — the parent-side state a click inside the frame leaves. */
function focusFrame() {
  iframeEl().focus();
  // Precondition, asserted: without it the copy tests would pass through the focus gate's
  // `none` branch and measure nothing.
  expect(document.activeElement).toBe(iframeEl());
}

/** What Next's popstate handler does to the router before React re-renders. */
function moveRouter(path: string[], asPath: string) {
  routerState.query = { slug: SLUG, path };
  routerState.asPath = asPath;
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
}

let savedAsPath: string;
let savedQuery: Record<string, unknown>;

beforeEach(() => {
  savedAsPath = routerState.asPath;
  savedQuery = routerState.query;
  pushMock().mockClear();
  replaceMock().mockClear();
  writeTextMock().mockReset();
  writeTextMock().mockResolvedValue(undefined);
  // A driven MessageEvent carries no activation; stand in for the click inside the frame.
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    value: { isActive: true, hasBeenActive: true },
  });
});

afterEach(() => {
  routerState.asPath = savedAsPath;
  routerState.query = savedQuery;
  delete (navigator as unknown as Record<string, unknown>).userActivation;
});

describe('BLOCK_INIT and ROUTE_CHANGED carry search and hash', () => {
  test('🔴 BLOCK_INIT.context carries search and hash from routerState.asPath, host `from` stripped', async () => {
    routerState.query = { slug: SLUG, path: ['c', '42'] };
    routerState.asPath = `/apps/run/${SLUG}/c/42?take=3&from=home#top`;
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await waitMounted();
    const posts = listenForHostPosts();
    await vi.waitFor(() => {
      if (posts.of('BLOCK_INIT').length === 0) throw new Error('no BLOCK_INIT yet');
    });
    const init = posts.last('BLOCK_INIT')!.payload as {
      context: { subPath: string; search?: string; hash?: string };
    };
    expect(init.context.subPath).toBe('c/42');
    expect(init.context.search).toBe('?take=3');
    expect(init.context.hash).toBe('#top');
    posts.stop();
  });

  test('BLOCK_INIT.context search and hash are empty strings on a bare route', async () => {
    routerState.query = { slug: SLUG };
    routerState.asPath = `/apps/run/${SLUG}`;
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await waitMounted();
    const posts = listenForHostPosts();
    await vi.waitFor(() => {
      if (posts.of('BLOCK_INIT').length === 0) throw new Error('no BLOCK_INIT yet');
    });
    const init = posts.last('BLOCK_INIT')!.payload as { context: Record<string, unknown> };
    expect(init.context.search).toBe('');
    expect(init.context.hash).toBe('');
    posts.stop();
  });

  test('🔴 a router move (Next on popstate: back/forward) delivers ROUTE_CHANGED with search and hash', async () => {
    routerState.query = { slug: SLUG, path: ['c', '42'] };
    routerState.asPath = `/apps/run/${SLUG}/c/42?take=3`;
    const { rerender } = await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const posts = listenForHostPosts();

    // Back: from the character to the gallery. Exactly ONE per move, not a burst.
    moveRouter([], `/apps/run/${SLUG}?sort=new#grid`);
    await rerender(<PageBlockHost {...baseProps} />);
    await expectOneRouteChangedTo(posts, { subPath: '', search: '?sort=new', hash: '#grid' });

    // Forward: back to the character and take. Counted from here on, because the
    // ROUTE_CHANGED sent at ready carried this same location; postMessage keeps order, so
    // it has landed by the time the move above was seen.
    const mark = posts.of('ROUTE_CHANGED').length;
    moveRouter(['c', '42'], `/apps/run/${SLUG}/c/42?take=3`);
    await rerender(<PageBlockHost {...baseProps} />);
    await expectOneRouteChangedTo(posts, { subPath: 'c/42', search: '?take=3', hash: '' }, mark);
    posts.stop();
  });

  test('🔴 a move that changes ONLY the search (same subPath) still delivers ROUTE_CHANGED', async () => {
    routerState.query = { slug: SLUG, path: ['c', '42'] };
    routerState.asPath = `/apps/run/${SLUG}/c/42?take=1`;
    const { rerender } = await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const posts = listenForHostPosts();

    moveRouter(['c', '42'], `/apps/run/${SLUG}/c/42?take=2`);
    await rerender(<PageBlockHost {...baseProps} />);
    await expectOneRouteChangedTo(posts, { subPath: 'c/42', search: '?take=2', hash: '' });
    posts.stop();
  });

  test('🔴 a hash-only move still delivers ROUTE_CHANGED', async () => {
    routerState.query = { slug: SLUG, path: ['c', '42'] };
    routerState.asPath = `/apps/run/${SLUG}/c/42`;
    const { rerender } = await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const posts = listenForHostPosts();

    moveRouter(['c', '42'], `/apps/run/${SLUG}/c/42#take-2`);
    await rerender(<PageBlockHost {...baseProps} />);
    await expectOneRouteChangedTo(posts, { subPath: 'c/42', search: '', hash: '#take-2' });
    posts.stop();
  });
});

describe('NAVIGATE history semantics', () => {
  test('INVARIANT: an app-scoped navigate pushes a history entry (shallow)', async () => {
    // Already true before this change (router.push is a pushState) — pinned so the
    // replace/dedupe work below cannot silently turn every navigate into a replace.
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: 'c/42?take=3' });

    await vi.waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    expect(router.push).toHaveBeenCalledWith(`/apps/run/${SLUG}/c/42?take=3`, undefined, {
      shallow: true,
      scroll: false,
    });
    expect(router.replace).not.toHaveBeenCalled();
  });

  test('🔴 replace:true replaces the entry instead of pushing one', async () => {
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: 'c/42?take=4', replace: true });

    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    expect(router.replace).toHaveBeenCalledWith(`/apps/run/${SLUG}/c/42?take=4`, undefined, {
      shallow: true,
      scroll: false,
    });
    expect(router.push).not.toHaveBeenCalled();
  });

  test('🔴 a navigate to the URL already showing creates no history entry', async () => {
    routerState.query = { slug: SLUG, path: ['c', '42'] };
    routerState.asPath = `/apps/run/${SLUG}/c/42?take=3`;
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: 'c/42?take=3' });
    // Control in the same run: a DIFFERENT url does push, so the bridge is live.
    postFromBlock('NAVIGATE', { path: 'c/43' });

    await vi.waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    expect(router.push).toHaveBeenCalledWith(`/apps/run/${SLUG}/c/43`, undefined, {
      shallow: true,
      scroll: false,
    });
  });

  test('🔴 two NAVIGATEs in one tick — into a view and straight back — push BOTH', async () => {
    // The dedupe used to read `router.asPath`, which still holds the PRE-push path until
    // the async push commits, so the second (back to the index) matched it and was dropped.
    routerState.query = { slug: SLUG };
    routerState.asPath = `/apps/run/${SLUG}`;
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: 'c/42' });
    postFromBlock('NAVIGATE', { path: '' });

    await vi.waitFor(() => expect(router.push).toHaveBeenCalledTimes(2));
    expect(pushMock().mock.calls).toEqual([
      [`/apps/run/${SLUG}/c/42`, undefined, { shallow: true, scroll: false }],
      [`/apps/run/${SLUG}`, undefined, { shallow: true, scroll: false }],
    ]);
    // …and the same index again is now the URL showing, so it adds nothing.
    postFromBlock('NAVIGATE', { path: '' });
    await settle();
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  test('🔴 after an address-bar hash edit (hashchange), a NAVIGATE to that URL adds no entry', async () => {
    // A hash-only address-bar edit never reaches the router, so `router.asPath` still reads
    // `/c/42`. The host resyncs its "showing" href from `window.location` on `hashchange`;
    // without that, the app re-asserting `c/42#notes` would stack a duplicate entry.
    routerState.query = { slug: SLUG, path: ['c', '42'] };
    routerState.asPath = `/apps/run/${SLUG}/c/42`;
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    const runnerUrl = window.location.href;
    try {
      window.history.replaceState(window.history.state, '', `/apps/run/${SLUG}/c/42#notes`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));

      postFromBlock('NAVIGATE', { path: 'c/42#notes' });
      // Control in the same run: a DIFFERENT url does push, so the bridge is live.
      postFromBlock('NAVIGATE', { path: 'c/43' });

      await vi.waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
      expect(pushMock().mock.calls).toEqual([
        [`/apps/run/${SLUG}/c/43`, undefined, { shallow: true, scroll: false }],
      ]);
      expect(router.replace).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(window.history.state, '', runnerUrl);
    }
  });

  test('replace:true does not change site-scope navigation (still a non-shallow push)', async () => {
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { scope: 'site', path: 'models/500', replace: true });

    await vi.waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    expect(router.push).toHaveBeenCalledWith('/models/500', undefined, undefined);
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('SHARE_LINK → SHARE_LINK_RESULT', () => {
  const ORIGIN = window.location.origin;

  test('🔴 builds the canonical URL, copies it, and reports copied:true only after the write resolved', async () => {
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const posts = listenForHostPosts();

    focusFrame();
    postFromBlock('SHARE_LINK', { requestId: 'share-1', subPath: 'c/42', search: '?take=3' });

    await vi.waitFor(() => {
      expect(posts.last('SHARE_LINK_RESULT')?.payload).toEqual({
        requestId: 'share-1',
        result: {
          url: `${ORIGIN}/apps/run/${SLUG}/c/42?take=3`,
          copied: true,
          method: 'clipboard',
        },
      });
    });
    expectReplyKeys('SHARE_LINK', 'success', ['result'], posts.last('SHARE_LINK_RESULT')!.payload);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `${ORIGIN}/apps/run/${SLUG}/c/42?take=3`
    );
    posts.stop();
  });

  test('🔴 a rejected clipboard write is copied:false, method none, with the url to show', async () => {
    writeTextMock().mockRejectedValue(
      new DOMException('Document is not focused.', 'NotAllowedError')
    );
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const posts = listenForHostPosts();

    focusFrame();
    postFromBlock('SHARE_LINK', { requestId: 'share-2', subPath: 'c/42' });

    await vi.waitFor(() => {
      expect(posts.last('SHARE_LINK_RESULT')?.payload).toEqual({
        requestId: 'share-2',
        result: { url: `${ORIGIN}/apps/run/${SLUG}/c/42`, copied: false, method: 'none' },
      });
    });
    // The write WAS attempted and rejected — not skipped by a gate.
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    posts.stop();
  });

  test('🔴 activation from a click on HOST chrome (focus outside the frame) copies nothing', async () => {
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const posts = listenForHostPosts();
    const hostButton = document.createElement('button');
    hostButton.textContent = 'host chrome';
    document.body.appendChild(hostButton);
    try {
      hostButton.focus();
      expect(document.activeElement).toBe(hostButton);

      postFromBlock('SHARE_LINK', { requestId: 'share-h', subPath: 'c/42' });

      await vi.waitFor(() => {
        expect(posts.last('SHARE_LINK_RESULT')?.payload).toEqual({
          requestId: 'share-h',
          result: { url: `${ORIGIN}/apps/run/${SLUG}/c/42`, copied: false, method: 'none' },
        });
      });
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    } finally {
      hostButton.remove();
    }
    posts.stop();
  });

  test.each([['//evil.com'], ['javascript:alert(1)'], ['../other-app']])(
    '🔴 refuses an escaping subPath %s with an error and copies nothing',
    async (subPath) => {
      await renderWithProviders(<PageBlockHost {...baseProps} />);
      await driveToReady();
      const posts = listenForHostPosts();

      postFromBlock('SHARE_LINK', { requestId: 'share-3', subPath });

      await vi.waitFor(() => {
        expect(posts.last('SHARE_LINK_RESULT')?.payload).toEqual({
          requestId: 'share-3',
          error: 'invalid share link',
        });
      });
      expectReplyKeys('SHARE_LINK', 'error', ['error'], posts.last('SHARE_LINK_RESULT')!.payload);
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
      posts.stop();
    }
  );

  test('🔴 a second SHARE_LINK inside the interval is refused as rate_limited (no second write)', async () => {
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const posts = listenForHostPosts();

    focusFrame();
    postFromBlock('SHARE_LINK', { requestId: 'share-a', subPath: 'c/1' });
    postFromBlock('SHARE_LINK', { requestId: 'share-b', subPath: 'c/2' });

    await vi.waitFor(() => expect(posts.of('SHARE_LINK_RESULT')).toHaveLength(2));
    const byId = Object.fromEntries(
      posts
        .of('SHARE_LINK_RESULT')
        .map((m) => [(m.payload as { requestId: string }).requestId, m.payload])
    );
    expect(byId['share-a']).toEqual({
      requestId: 'share-a',
      result: { url: `${ORIGIN}/apps/run/${SLUG}/c/1`, copied: true, method: 'clipboard' },
    });
    expect(byId['share-b']).toEqual({ requestId: 'share-b', error: 'rate_limited' });
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    posts.stop();
  });

  test('🔴 the share URL carries no host-owned pair (`sl`, `src`, `from`)', async () => {
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const posts = listenForHostPosts();
    focusFrame();

    postFromBlock('SHARE_LINK', {
      requestId: 'share-s',
      subPath: 'c/42',
      search: '?sl=asl_x&take=3&src=detail&from=home',
    });

    await vi.waitFor(() => {
      expect(posts.last('SHARE_LINK_RESULT')?.payload).toEqual({
        requestId: 'share-s',
        result: {
          url: `${ORIGIN}/apps/run/${SLUG}/c/42?take=3`,
          copied: true,
          method: 'clipboard',
        },
      });
    });
    posts.stop();
  });

  test('🔴 refused on the dev tunnel (its slug is a block id, so the link would 404)', async () => {
    // `dev-tunnel` HAS a deep-link base (`/apps/run`), so only `BLOCK_HOST_SHARE_LINK` refuses
    // it: the frame has focus and activation is stubbed, so a wrongly shareable surface copies.
    await renderWithProviders(
      <PageBlockHost
        {...baseProps}
        surface="dev-tunnel"
        onConsentGranted={vi.fn()}
        onRetryToken={vi.fn()}
      />
    );
    await driveToReady();
    const posts = listenForHostPosts();
    focusFrame();

    postFromBlock('SHARE_LINK', { requestId: 'share-d', subPath: 'c/1' });

    await vi.waitFor(() => {
      expect(posts.last('SHARE_LINK_RESULT')?.payload).toEqual({
        requestId: 'share-d',
        error: 'sharing is not available here',
      });
    });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    posts.stop();
  });

  test('refused in review mode', async () => {
    await renderWithProviders(<PageBlockHost {...baseProps} surface="review-preview" reviewMode />);
    await driveToReady();
    const posts = listenForHostPosts();

    postFromBlock('SHARE_LINK', { requestId: 'share-r', subPath: 'c/1' });

    await vi.waitFor(() => {
      expect(posts.last('SHARE_LINK_RESULT')?.payload).toEqual({
        requestId: 'share-r',
        error: 'sharing is not available here',
      });
    });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    posts.stop();
  });
});
