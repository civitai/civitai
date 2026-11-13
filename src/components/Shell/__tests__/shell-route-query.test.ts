// @vitest-environment happy-dom
import Router from 'next/dist/shared/lib/router/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requiredRouteParams,
  routeQueryPending,
  syncShellRouteQuery,
} from '~/components/Shell/shell-route-query';
import {
  adoptShellPageData,
  shellPageDataPrefetchScript,
} from '~/components/Shell/shell-page-data';

/**
 * A route-level shell boots Next's client router with an EMPTY query (that is what the shell's
 * `__NEXT_DATA__` carries) and the real `location`. These run the REAL Next 16.3.1 pages router —
 * `next/dist/shared/lib/router/router`, constructed as `next/dist/client/index.js` constructs it —
 * so what is pinned is that router's behaviour, not a stub's.
 */

const ROUTE = '/images/[imageId]';

type Events = { on: (e: string, fn: () => void) => void; off: (e: string, fn: () => void) => void };
const routerEvents = (Router as unknown as { events: Events }).events;

/** The router `next/dist/client/index.js` creates for a shell page at `href`. */
function bootShellRouter(href: string) {
  window.history.replaceState(null, '', href);
  (window as unknown as { __NEXT_DATA__: unknown }).__NEXT_DATA__ = {
    page: ROUTE,
    query: {},
    props: { pageProps: { shell: true } },
    gssp: true,
    appGip: true,
    buildId: 'test-build',
  };
  (self as unknown as { __BUILD_MANIFEST: unknown }).__BUILD_MANIFEST = {
    sortedPages: ['/_app', ROUTE],
    __rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
  };
  const renders: unknown[] = [];
  const { pathname, search, hash } = window.location;
  const router = new Router(ROUTE, {}, `${pathname}${search}${hash}`, {
    initialProps: { pageProps: { shell: true } },
    pageLoader: {
      getPageList: async () => ['/_app', ROUTE],
      getMiddleware: async () => undefined,
      getDataHref: () => {
        throw new Error('no data request expected');
      },
      loadPage: async () => {
        throw new Error('no page load expected');
      },
      _isSsg: async () => false,
    },
    App: () => null,
    Component: () => null,
    wrapApp: (app: unknown) => app,
    err: undefined,
    isFallback: false,
    subscription: async (info: unknown) => {
      renders.push(info);
    },
    locale: undefined,
    locales: undefined,
    defaultLocale: undefined,
    domainLocales: undefined,
    isPreview: false,
  } as never);
  return { router, renders };
}

function recordRouteEvents() {
  const seen: string[] = [];
  const handlers = ['routeChangeStart', 'routeChangeComplete', 'hashChangeStart'].map((name) => {
    const fn = () => seen.push(name);
    routerEvents.on(name, fn);
    return [name, fn] as const;
  });
  return {
    seen,
    stop: () => handlers.forEach(([name, fn]) => routerEvents.off(name, fn)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__civShell;
});

describe('syncShellRouteQuery on the real Next router', () => {
  it.each([
    ['a bare image URL', '/images/123', { imageId: '123' }],
    [
      'a URL with a query and a hash',
      '/images/123?postId=5&collectionId=9#comments',
      { imageId: '123', postId: '5', collectionId: '9' },
    ],
    ['a large id', '/images/987654321', { imageId: '987654321' }],
  ])('restores the route query for %s', async (_, href, expected) => {
    const { router } = bootShellRouter(href);
    expect(routeQueryPending(router)).toBe(true);
    const events = recordRouteEvents();
    try {
      await syncShellRouteQuery(router);
    } finally {
      events.stop();
    }
    expect(router.query).toEqual(expected);
    expect(routeQueryPending(router)).toBe(false);
    // The address bar and history entry are untouched, and nothing reads it as a navigation.
    expect(router.asPath).toBe(href);
    expect(`${location.pathname}${location.search}${location.hash}`).toBe(href);
    expect(events.seen).toEqual([]);
  });

  it('CONTROL: a plain shallow replace of a URL with a hash leaves the query empty', async () => {
    // Why the sync passes Next's `_h` option: Next reads this as a hash-only change.
    const href = '/images/123#comments';
    const { router } = bootShellRouter(href);
    await router.replace(`${ROUTE}`, href, { shallow: true });
    expect(router.query).toEqual({});
  });
});

describe('the page-data request of a shell page targets the page’s own URL', () => {
  const stubFetch = () => {
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        calls.push([String(input), init]);
        return new Response('{}', { status: 404 });
      })
    );
    return calls;
  };

  it('from the inline head script, which the app then adopts without a second request', async () => {
    window.history.replaceState(null, '', '/images/123?postId=5#comments');
    const calls = stubFetch();
    new Function(shellPageDataPrefetchScript())();
    expect(window.__civShell).toBeInstanceOf(Promise);
    await adoptShellPageData();
    expect(calls).toEqual([
      [
        '/api/page-data/images/123?postId=5',
        { credentials: 'same-origin', headers: { accept: 'application/json' } },
      ],
    ]);
  });

  it('from the app when the inline script did not run', async () => {
    window.history.replaceState(null, '', '/images/987654321');
    const calls = stubFetch();
    await adoptShellPageData();
    expect(calls.map(([url]) => url)).toEqual(['/api/page-data/images/987654321']);
  });

  // Vitest fails the run on an unhandled rejection, which a request failing before the app
  // attaches would be without the script's own no-op handler.
  it('a failing inline request reaches the app as a failure, not as an unhandled rejection', async () => {
    window.history.replaceState(null, '', '/images/123');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      })
    );
    new Function(shellPageDataPrefetchScript())();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await adoptShellPageData()).toEqual({ ok: false, status: 0 });
  });
});

describe('requiredRouteParams', () => {
  it.each([
    ['/images/[imageId]', ['imageId']],
    ['/models/[id]/[[...slug]]', ['id']],
    ['/user/[username]/[...rest]', ['username', 'rest']],
    ['/images', []],
  ])('%s → %j', (pattern, expected) => {
    expect(requiredRouteParams(pattern)).toEqual(expected);
  });
});
