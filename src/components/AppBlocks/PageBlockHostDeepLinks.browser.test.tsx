// The scaffold's `next/router` mock exports ONE router singleton as `default`,
// `Router` and the `useRouter()` return value alike (see PageBlockHostNavigate).
import Router from 'next/router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';

/**
 * Deep links into app state, the share link, and back/forward (HQ app_blocks_sdk_j1gc) —
 * the HOST-INTEGRATION half. The pure rules are unit-tested in
 * `__tests__/deepLinkLogic.test.ts`; this file mounts the REAL `PageBlockHost` and drives
 * the REAL postMessage bridge.
 *
 *  1. BLOCK_INIT.context and ROUTE_CHANGED carry `search` and `hash` from `router.asPath`
 *     (host-owned `from` stripped).
 *  2. A router move — what Next does on popstate (back/forward) — delivers ROUTE_CHANGED,
 *     including a move that changes ONLY the search or the hash.
 *  3. NAVIGATE: app scope pushes a history entry; `replace: true` replaces instead; a
 *     navigate to the URL already showing pushes nothing.
 *  4. SHARE_LINK → SHARE_LINK_RESULT with the canonical URL, copied only when the
 *     clipboard write resolved, refusals for escapes, and a rate limit.
 *
 * ⚠️ WHAT THIS FILE CANNOT SEE: the `next/router` mock is a static object, so there is no
 * real history stack. "Back returns to the gallery" depends on Next's own popstate handler
 * updating `router.query`/`router.asPath`; here that update is simulated by mutating the
 * mock and re-rendering. The real back/forward path is a manual check (the Live Characters
 * builder seat), stated in the PR. Likewise a driven MessageEvent carries no user
 * activation, so `navigator.userActivation` is stubbed; the activation-propagation
 * measurement behind the synchronous write is recorded at the handler.
 */

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
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
const router = Router as unknown as typeof Router & MutableRouter;
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
    new MessageEvent('message', { data: { type, payload }, origin: window.location.origin, source: cw })
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

/** What Next's popstate handler does to the router before React re-renders. */
function moveRouter(path: string[], asPath: string) {
  router.query = { slug: SLUG, path };
  router.asPath = asPath;
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
}

let savedAsPath: string;
let savedQuery: Record<string, unknown>;

beforeEach(() => {
  savedAsPath = router.asPath;
  savedQuery = router.query;
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
  router.asPath = savedAsPath;
  router.query = savedQuery;
  delete (navigator as unknown as Record<string, unknown>).userActivation;
});

describe('BLOCK_INIT and ROUTE_CHANGED carry search and hash', () => {
  test('🔴 BLOCK_INIT.context carries search and hash from router.asPath, host `from` stripped', async () => {
    router.query = { slug: SLUG, path: ['c', '42'] };
    router.asPath = `/apps/run/${SLUG}/c/42?take=3&from=home#top`;
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
    router.query = { slug: SLUG };
    router.asPath = `/apps/run/${SLUG}`;
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
    router.query = { slug: SLUG, path: ['c', '42'] };
    router.asPath = `/apps/run/${SLUG}/c/42?take=3`;
    const { rerender } = await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const posts = listenForHostPosts();

    // Back: from the character to the gallery.
    moveRouter([], `/apps/run/${SLUG}?sort=new#grid`);
    await rerender(<PageBlockHost {...baseProps} />);
    await vi.waitFor(() => {
      expect(posts.last('ROUTE_CHANGED')?.payload).toEqual({ subPath: '', search: '?sort=new', hash: '#grid' });
    });

    // Forward: back to the character and take.
    moveRouter(['c', '42'], `/apps/run/${SLUG}/c/42?take=3`);
    await rerender(<PageBlockHost {...baseProps} />);
    await vi.waitFor(() => {
      expect(posts.last('ROUTE_CHANGED')?.payload).toEqual({ subPath: 'c/42', search: '?take=3', hash: '' });
    });
    posts.stop();
  });

  test('🔴 a move that changes ONLY the search (same subPath) still delivers ROUTE_CHANGED', async () => {
    router.query = { slug: SLUG, path: ['c', '42'] };
    router.asPath = `/apps/run/${SLUG}/c/42?take=1`;
    const { rerender } = await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const posts = listenForHostPosts();

    moveRouter(['c', '42'], `/apps/run/${SLUG}/c/42?take=2`);
    await rerender(<PageBlockHost {...baseProps} />);
    await vi.waitFor(() => {
      expect(posts.last('ROUTE_CHANGED')?.payload).toEqual({ subPath: 'c/42', search: '?take=2', hash: '' });
    });
    posts.stop();
  });

  test('🔴 a hash-only move still delivers ROUTE_CHANGED', async () => {
    router.query = { slug: SLUG, path: ['c', '42'] };
    router.asPath = `/apps/run/${SLUG}/c/42`;
    const { rerender } = await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const posts = listenForHostPosts();

    moveRouter(['c', '42'], `/apps/run/${SLUG}/c/42#take-2`);
    await rerender(<PageBlockHost {...baseProps} />);
    await vi.waitFor(() => {
      expect(posts.last('ROUTE_CHANGED')?.payload).toEqual({ subPath: 'c/42', search: '', hash: '#take-2' });
    });
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
    expect(router.push).toHaveBeenCalledWith(`/apps/run/${SLUG}/c/42?take=3`, undefined, { shallow: true });
    expect(router.replace).not.toHaveBeenCalled();
  });

  test('🔴 replace:true replaces the entry instead of pushing one', async () => {
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: 'c/42?take=4', replace: true });

    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    expect(router.replace).toHaveBeenCalledWith(`/apps/run/${SLUG}/c/42?take=4`, undefined, { shallow: true });
    expect(router.push).not.toHaveBeenCalled();
  });

  test('🔴 a navigate to the URL already showing creates no history entry', async () => {
    router.query = { slug: SLUG, path: ['c', '42'] };
    router.asPath = `/apps/run/${SLUG}/c/42?take=3`;
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: 'c/42?take=3' });
    // Control in the same run: a DIFFERENT url does push, so the bridge is live.
    postFromBlock('NAVIGATE', { path: 'c/43' });

    await vi.waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    expect(router.push).toHaveBeenCalledWith(`/apps/run/${SLUG}/c/43`, undefined, { shallow: true });
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

    postFromBlock('SHARE_LINK', { requestId: 'share-1', subPath: 'c/42', search: '?take=3' });

    await vi.waitFor(() => {
      expect(posts.last('SHARE_LINK_RESULT')?.payload).toEqual({
        requestId: 'share-1',
        result: { url: `${ORIGIN}/apps/run/${SLUG}/c/42?take=3`, copied: true, method: 'clipboard' },
      });
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`${ORIGIN}/apps/run/${SLUG}/c/42?take=3`);
    posts.stop();
  });

  test('🔴 a rejected clipboard write is copied:false, method none, with the url to show', async () => {
    writeTextMock().mockRejectedValue(new DOMException('Document is not focused.', 'NotAllowedError'));
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const posts = listenForHostPosts();

    postFromBlock('SHARE_LINK', { requestId: 'share-2', subPath: 'c/42' });

    await vi.waitFor(() => {
      expect(posts.last('SHARE_LINK_RESULT')?.payload).toEqual({
        requestId: 'share-2',
        result: { url: `${ORIGIN}/apps/run/${SLUG}/c/42`, copied: false, method: 'none' },
      });
    });
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
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
      posts.stop();
    }
  );

  test('🔴 a second SHARE_LINK inside the interval is refused as rate_limited (no second write)', async () => {
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const posts = listenForHostPosts();

    postFromBlock('SHARE_LINK', { requestId: 'share-a', subPath: 'c/1' });
    postFromBlock('SHARE_LINK', { requestId: 'share-b', subPath: 'c/2' });

    await vi.waitFor(() => expect(posts.of('SHARE_LINK_RESULT')).toHaveLength(2));
    const byId = Object.fromEntries(
      posts.of('SHARE_LINK_RESULT').map((m) => [(m.payload as { requestId: string }).requestId, m.payload])
    );
    expect(byId['share-a']).toEqual({
      requestId: 'share-a',
      result: { url: `${ORIGIN}/apps/run/${SLUG}/c/1`, copied: true, method: 'clipboard' },
    });
    expect(byId['share-b']).toEqual({ requestId: 'share-b', error: 'rate_limited' });
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
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
