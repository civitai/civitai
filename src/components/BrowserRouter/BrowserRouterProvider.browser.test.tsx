import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import Router from 'next/router';
import {
  BrowserRouterProvider,
  setUsingNextRouter,
  useBrowserRouter,
} from '~/components/BrowserRouter/BrowserRouterProvider';
import { ClientHistoryStore } from '~/store/ClientHistoryStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// Integration coverage for the Safari/iOS back-navigation crash, exercised at
// the REAL call-sites (the live popstate handlers) in a browser:
//   - BrowserRouterProvider popstate → `locationchange` → reads `.as` on null e.state
//   - ClientHistoryStore   popstate → reads `.state.key` on null e.state
// Safari nulls `history.state` / popstate `e.state` on some back/forward +
// bfcache restores; the old handlers threw `TypeError: null is not an object`
// and broke the back button for iOS users.
//
// IMPORTANT (why the ordering matters): the popstate listeners attach in a mount
// `useEffect`, so a `popstate` dispatched immediately after render is LOST (the
// listener isn't live yet) — such a test would silently pass even against the
// broken code. So we first dispatch a POPULATED popstate and `waitFor` asPath to
// update, which proves the listeners are live, THEN dispatch the null popstate.
// The reliable regression signal is that the null popstate still drives asPath to
// the current-location fallback: the OLD code throws before `setState`, so asPath
// would stay stuck at the previous value and this assertion fails. (Listener
// exceptions are swallowed by the browser event system and do not surface on the
// window `error` event, so an onError spy is NOT a reliable guard here.)

function AsPathProbe() {
  const { asPath, query, state } = useBrowserRouter();
  return (
    <>
      <div data-testid="aspath">{asPath}</div>
      <div data-testid="imageid">{String(query.imageId)}</div>
      <div data-testid="prev">{String(state?.prev?.asPath)}</div>
    </>
  );
}
const probeText = () => page.getByTestId('aspath').element().textContent;
const imageIdText = () => page.getByTestId('imageid').element().textContent;
const prevText = () => page.getByTestId('prev').element().textContent;

describe('BrowserRouterProvider + ClientHistoryStore popstate handling (Safari null state)', () => {
  test('a back navigation with null history.state degrades to the current location instead of crashing', async () => {
    const originalState = window.history.state;
    try {
      renderWithProviders(
        <>
          <ClientHistoryStore />
          <BrowserRouterProvider>
            <AsPathProbe />
          </BrowserRouterProvider>
        </>
      );

      // 1) Establish that the popstate listeners are live: a populated
      //    (Next.js-style) state must drive asPath. This is also the happy-path
      //    assertion (behaviour unchanged for the non-null case). The listeners
      //    attach in a mount effect, so we re-dispatch inside `waitFor` until the
      //    effect is live (a single dispatch right after render is lost).
      const populated = {
        key: 'abc123',
        as: '/search?query=cats',
        url: '/search?query=cats',
        state: { prev: { asPath: '/models' } },
      };
      window.history.replaceState(populated, '');
      await vi.waitFor(() => {
        window.dispatchEvent(new PopStateEvent('popstate', { state: populated }));
        expect(probeText()).toBe('/search?query=cats');
      });

      // 2) The iOS back-button state: history.state === null, popstate with a
      //    null state (what Safari delivers). The OLD handlers threw
      //    `TypeError: null is not an object (evaluating 't.as' / 't.state.key')`
      //    here and left asPath stuck at '/search?query=cats'. The guarded code
      //    must instead degrade to the current location so navigation still
      //    reflects the real URL.
      window.history.replaceState(null, '');
      expect(window.history.state).toBeNull();
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));

      const locationFallback = `${window.location.pathname}${window.location.search}`;
      await vi.waitFor(() => {
        expect(probeText()).toBe(locationFallback);
      });
      // Sanity: it actually changed away from the populated value (i.e. the null
      // handler ran and did not throw before updating).
      expect(probeText()).not.toBe('/search?query=cats');
    } finally {
      window.history.replaceState(originalState, '');
    }
  });
});

// A back navigation onto `/images/[imageId]` from another dynamic route
// (ClickUp 868kt41x7). Next owns this pop and repopulates its own `router.query`
// with the path params of the route it just rendered — but the provider then
// overwrote that on `routeChangeComplete` with state rebuilt in the popstate
// handler, where `Router.pathname` was still the route being LEFT. The page,
// which reads its id from the browser router, saw no `imageId` and rendered its
// not-found branch; a refresh of the same URL loaded fine.
describe('BrowserRouterProvider back navigation onto a dynamic route', () => {
  test("publishes Next's query for the route it just rendered", async () => {
    const originalState = window.history.state;
    const originalAsPath = Router.asPath;
    const originalQuery = Router.query;
    const on = vi.mocked(Router.events.on);
    const passThrough = on.getMockImplementation();
    const handlers: Array<(url: string) => void> = [];
    on.mockImplementation(((event: string, fn: (url: string) => void) => {
      if (event === 'routeChangeComplete') handlers.push(fn);
      return passThrough?.(event as never, fn as never);
    }) as typeof Router.events.on);

    try {
      renderWithProviders(
        <BrowserRouterProvider>
          <AsPathProbe />
        </BrowserRouterProvider>
      );

      // Prove the popstate listener is live before the assertion that matters —
      // it attaches in a mount effect, so a single early dispatch is lost and the
      // test would pass against the broken code.
      setUsingNextRouter(false);
      const liveness = { as: '/models?sort=Newest', url: '/models?sort=Newest', state: {} };
      window.history.replaceState(liveness, '');
      await vi.waitFor(() => {
        window.dispatchEvent(new PopStateEvent('popstate', { state: liveness }));
        expect(probeText()).toBe('/models?sort=Newest');
      });
      expect(imageIdText()).toBe('undefined');

      // The pop: leaving `/models/[id]`, landing on `/images/135356251`. Next
      // takes this one, which is what defers the commit to `routeChangeComplete`.
      setUsingNextRouter(true);
      const popped = {
        as: '/images/135356251',
        url: '/images/135356251',
        state: { prev: { asPath: '/models/827184' } },
      };
      window.history.replaceState(popped, '');
      window.dispatchEvent(new PopStateEvent('popstate', { state: popped }));

      // Next finishes: it has interpolated `imageId` into its own query, and only
      // then emits `routeChangeComplete`. Its `changeState` has already replaced
      // `history.state` with its own shape — note there is no `state` key, so the
      // entry's payload now exists only in the popstate snapshot.
      window.history.replaceState(
        { url: '/images/[imageId]', as: '/images/135356251', options: {}, __N: true, key: 'k' },
        ''
      );
      Router.asPath = '/images/135356251';
      Router.query = { imageId: '135356251' };
      expect(handlers.length).toBeGreaterThan(0);
      for (const handler of handlers) handler('/images/135356251');

      await vi.waitFor(() => {
        expect(probeText()).toBe('/images/135356251');
      });
      // The regression: this read `undefined` and `/images/[imageId]` rendered
      // `<NotFound />`.
      expect(imageIdText()).toBe('135356251');
      // And the entry's payload survives, which routed dialogs are handed as props.
      expect(prevText()).toBe('/models/827184');
    } finally {
      setUsingNextRouter(false);
      Router.asPath = originalAsPath;
      Router.query = originalQuery;
      on.mockImplementation(passThrough ?? (() => undefined));
      window.history.replaceState(originalState, '');
    }
  });
});

// After a hash-only back navigation, routed dialogs stopped opening (ClickUp
// 868kta76n). `beforePopState` raises `usingNextRouter` for every pop it hands
// to Next, and the flag was lowered only in the `routeChangeComplete` handler —
// but Next's hash-only branch emits `hashChangeComplete` and returns, so the
// flag stayed raised and the `locationchange` handler dropped every update after
// it. Measured on a dev server: after `router.push('/images#probe')` and back, a
// feed card changed the URL to `/images/139360504` and no dialog appeared;
// without the pop the same click opened it every time.
describe('BrowserRouterProvider after a hash-only navigation', () => {
  test('keeps publishing location changes, so routed dialogs still open', async () => {
    const originalState = window.history.state;
    const on = vi.mocked(Router.events.on);
    const passThrough = on.getMockImplementation();
    const handlers: Record<string, Array<() => void>> = {};
    on.mockImplementation(((event: string, fn: () => void) => {
      (handlers[event] ??= []).push(fn);
      return passThrough?.(event as never, fn as never);
    }) as typeof Router.events.on);

    try {
      renderWithProviders(
        <BrowserRouterProvider>
          <AsPathProbe />
        </BrowserRouterProvider>
      );

      setUsingNextRouter(false);
      const liveness = { as: '/images', url: '/images', state: {} };
      window.history.replaceState(liveness, '');
      await vi.waitFor(() => {
        window.dispatchEvent(new PopStateEvent('popstate', { state: liveness }));
        expect(probeText()).toBe('/images');
      });

      // The hash-only pop: `beforePopState` hands it to Next, which emits
      // `hashChangeComplete` and never `routeChangeComplete`.
      setUsingNextRouter(true);
      expect(handlers.hashChangeComplete?.length ?? 0).toBeGreaterThan(0);
      for (const handler of handlers.hashChangeComplete ?? []) handler();

      // What a routed dialog opening looks like: `browserRouter.push` dispatches
      // `locationchange`, and the provider must still publish it.
      const opened = {
        as: '/images/139360504',
        url: '/images?dialog=imageDetail&imageId=139360504',
        state: {},
      };
      window.history.replaceState(opened, '');
      window.dispatchEvent(new CustomEvent('locationchange', { detail: [opened] }));

      await vi.waitFor(() => {
        expect(probeText()).toBe('/images/139360504');
      });
      // The regression: the flag was still raised, this update was dropped, and
      // asPath stayed at '/images' with no dialog on screen.
      expect(imageIdText()).toBe('139360504');
    } finally {
      setUsingNextRouter(false);
      on.mockImplementation(passThrough ?? (() => undefined));
      window.history.replaceState(originalState, '');
    }
  });
});
