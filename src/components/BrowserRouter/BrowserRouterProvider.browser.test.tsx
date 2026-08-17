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
  const { asPath, query } = useBrowserRouter();
  return (
    <>
      <div data-testid="aspath">{asPath}</div>
      <div data-testid="imageid">{String(query.imageId)}</div>
    </>
  );
}
const probeText = () => page.getByTestId('aspath').element().textContent;
const imageIdText = () => page.getByTestId('imageid').element().textContent;

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
// (ClickUp 868kt41x7). Next owns this pop, but the browser-router state was
// resolved in the popstate handler — where `Router.pathname` is still the route
// being LEFT — and then committed verbatim on `routeChangeComplete`, landing a
// query with no `imageId` on a page that reads its id from there. The page
// rendered its not-found branch; a refresh loaded the same URL fine.
describe('BrowserRouterProvider back navigation onto a dynamic route', () => {
  test('keeps the path param of the route being returned TO, not the one being left', async () => {
    const originalState = window.history.state;
    const originalPathname = Router.pathname;
    const handlers: Array<(url: string) => void> = [];
    vi.mocked(Router.events.on).mockImplementation(((event: string, fn: (url: string) => void) => {
      if (event === 'routeChangeComplete') handlers.push(fn);
    }) as any);

    try {
      renderWithProviders(
        <BrowserRouterProvider>
          <AsPathProbe />
        </BrowserRouterProvider>
      );

      // Prove the popstate listener is live before the assertion that matters —
      // it attaches in a mount effect, so a single early dispatch is lost and
      // the test would pass against the broken code.
      setUsingNextRouter(false);
      const liveness = { as: '/models?sort=Newest', url: '/models?sort=Newest', state: {} };
      window.history.replaceState(liveness, '');
      await vi.waitFor(() => {
        window.dispatchEvent(new PopStateEvent('popstate', { state: liveness }));
        expect(probeText()).toBe('/models?sort=Newest');
      });
      expect(imageIdText()).toBe('undefined');

      // The pop itself: leaving `/models/[id]`, landing on `/images/135356251`.
      // `beforePopState` hands this one to Next, which is what defers the state
      // commit to `routeChangeComplete`.
      Router.pathname = '/models/[id]';
      setUsingNextRouter(true);
      const popped = { as: '/images/135356251', url: '/images/135356251', state: {} };
      window.history.replaceState(popped, '');
      window.dispatchEvent(new PopStateEvent('popstate', { state: popped }));

      // Next finishes the transition: the rendered route is now the image page.
      Router.pathname = '/images/[imageId]';
      expect(handlers.length).toBeGreaterThan(0);
      for (const handler of handlers) handler('/images/135356251');

      await vi.waitFor(() => {
        expect(probeText()).toBe('/images/135356251');
      });
      // The regression: this read `undefined` and `/images/[imageId]` rendered
      // `<NotFound />`.
      expect(imageIdText()).toBe('135356251');
    } finally {
      setUsingNextRouter(false);
      Router.pathname = originalPathname;
      vi.mocked(Router.events.on).mockReset();
      window.history.replaceState(originalState, '');
    }
  });
});
