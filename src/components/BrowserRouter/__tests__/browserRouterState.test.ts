import { describe, expect, it } from 'vitest';
import {
  resolveLocationChangeState,
  resolveRouteChangeState,
} from '~/components/BrowserRouter/browserRouterState';

// Regression coverage for the Safari/iOS back-navigation crash:
//   TypeError: null is not an object (evaluating 't.as')
//     at src/components/BrowserRouter/BrowserRouterProvider.tsx (popstate handler)
// The popstate handler dispatches `locationchange` with `detail: [e.state]`; on
// Safari `e.state` (and `history.state`) can be null on back/forward + bfcache
// restores. Reading `.as` / `.url` / `.state` off null threw and broke back-nav.
// `resolveLocationChangeState` is the shared guard: it degrades to the CURRENT
// LOCATION (already updated by popstate) so navigation still reflects the real
// URL instead of crashing.
describe('resolveLocationChangeState', () => {
  const location = { pathname: '/models', search: '?sort=Newest' };

  describe('the Safari/iOS null case (the crash)', () => {
    it('does not throw when both popstate state and history.state are null', () => {
      expect(() => resolveLocationChangeState(null, null, location)).not.toThrow();
    });

    it('falls back to the current location for asPath + query when state is null', () => {
      const result = resolveLocationChangeState(null, null, location);
      // asPath reflects the real (already-navigated) URL, not a crash / blank.
      expect(result.asPath).toBe('/models?sort=Newest');
      // query parsed from the current location, not from a null state.
      expect(result.query).toEqual({ sort: 'Newest' });
      // state degrades to an empty object (context type expects an object).
      expect(result.state).toEqual({});
    });

    it('handles a root location with no search string', () => {
      const result = resolveLocationChangeState(null, null, { pathname: '/', search: '' });
      expect(result.asPath).toBe('/');
      expect(result.query).toEqual({});
      expect(result.state).toEqual({});
    });

    it('uses history.state.url for query when popstate e.state is null but history.state exists', () => {
      // Safari can null the popstate `e.state` while `history.state` is present.
      const historyState = {
        url: '/search?query=cats',
        as: '/search',
        state: { prev: { asPath: '/' } },
      };
      const result = resolveLocationChangeState(null, historyState, location);
      // asPath still degrades to location (e.state.as is what normally supplies it).
      expect(result.asPath).toBe('/models?sort=Newest');
      // query comes from history.state.url.
      expect(result.query).toEqual({ query: 'cats' });
      // nested state preserved from history.state.state.
      expect(result.state).toEqual({ prev: { asPath: '/' } });
    });
  });

  describe('the Chrome / happy path (unchanged)', () => {
    it('reads asPath/query/state from the populated popstate state object', () => {
      const eventState = {
        as: '/search?query=dogs',
        url: '/search?query=dogs',
        state: { prev: { asPath: '/models' } },
      };
      const historyState = { ...eventState };
      const result = resolveLocationChangeState(eventState, historyState, location);
      expect(result.asPath).toBe('/search?query=dogs');
      expect(result.query).toEqual({ query: 'dogs' });
      expect(result.state).toEqual({ prev: { asPath: '/models' } });
    });

    it('parses an empty query when the state url has no query string', () => {
      const eventState = { as: '/models', url: '/models', state: {} };
      const result = resolveLocationChangeState(eventState, eventState, location);
      expect(result.asPath).toBe('/models');
      expect(result.query).toEqual({});
      expect(result.state).toEqual({});
    });
  });

  // Closing a routed dialog back onto `/images/[imageId]` is a pop Next does not
  // handle (`RoutedDialogProvider.beforePopState` returns false), so `router.query`
  // never re-interpolates the path param and this is the only thing that runs.
  // Without the route pattern the page saw no `imageId` and rendered a 404.
  describe('dynamic route params', () => {
    const imagePage = { pathname: '/images/135356251', search: '' };

    it('recovers a path param that appears in no query string', () => {
      const eventState = { as: '/images/135356251', url: '/images/135356251', state: {} };
      const result = resolveLocationChangeState(
        eventState,
        eventState,
        imagePage,
        '/images/[imageId]'
      );
      expect(result.query.imageId).toBe(135356251);
    });

    it('types the param like the rest of the query rather than as a string', () => {
      // Consumers hand `imageId` straight to tRPC inputs typed as numbers.
      const eventState = { as: '/images/135356251', url: '/images/135356251', state: {} };
      const result = resolveLocationChangeState(
        eventState,
        eventState,
        imagePage,
        '/images/[imageId]'
      );
      expect(typeof result.query.imageId).toBe('number');
    });

    it('lets an explicit query string win over the path param', () => {
      const eventState = {
        as: '/images/135356251',
        url: '/images/[imageId]?imageId=999&dialog=imageDetail',
        state: {},
      };
      const result = resolveLocationChangeState(
        eventState,
        eventState,
        imagePage,
        '/images/[imageId]'
      );
      expect(result.query.imageId).toBe(999);
      expect(result.query.dialog).toBe('imageDetail');
    });

    it('contributes nothing when the pattern does not match the path', () => {
      // A pop to a different route: Next owns that one and repopulates the query
      // on routeChangeComplete, so we must not inject stale params here.
      const eventState = { as: '/models?sort=Newest', url: '/models?sort=Newest', state: {} };
      const result = resolveLocationChangeState(
        eventState,
        eventState,
        location,
        '/images/[imageId]'
      );
      expect(result.query).toEqual({ sort: 'Newest' });
    });

    it('is a no-op for a static route pattern', () => {
      const eventState = { as: '/images', url: '/images', state: {} };
      const result = resolveLocationChangeState(eventState, eventState, location, '/images');
      expect(result.query).toEqual({});
    });
  });
});

// The popstate handler resolves against the route being LEFT, so a pop Next owns
// — `/models/[id]` back onto `/images/123` — matched no pattern and produced a
// query with no `imageId`. `BrowserRouterProvider` commits that on
// `routeChangeComplete`, so the params have to be re-derived there against the
// route now rendered.
describe('resolveRouteChangeState', () => {
  it("publishes Next's query, which has the params of the route just rendered", () => {
    const result = resolveRouteChangeState(
      { asPath: '/images/135356251', query: { imageId: '135356251' } },
      {}
    );
    expect(result.asPath).toBe('/images/135356251');
    expect(result.query.imageId).toBe(135356251);
  });

  it('types params like the rest of the query rather than as strings', () => {
    // Consumers hand `imageId` straight to tRPC inputs typed as numbers.
    const result = resolveRouteChangeState(
      { asPath: '/images/135356251', query: { imageId: '135356251' } },
      {}
    );
    expect(typeof result.query.imageId).toBe('number');
  });

  it('carries the history state, which Next does not', () => {
    const result = resolveRouteChangeState(
      { asPath: '/images/135356251', query: { imageId: '135356251' } },
      { prev: { asPath: '/models/827184' } }
    );
    expect(result.state).toEqual({ prev: { asPath: '/models/827184' } });
  });

  it('publishes only what Next has, so nothing can be merged over it', () => {
    // Not a re-derivation: the query is copied whole. A reader who reintroduced a
    // merge would have somewhere for an outgoing-route param to come back in.
    const result = resolveRouteChangeState(
      { asPath: '/comics/project/55/chapter/2', query: { id: '55', chapterPosition: '2' } },
      {}
    );
    expect(Object.keys(result.query)).toEqual(['id', 'chapterPosition']);
    expect(result.query.id).toBe(55);
  });
});

describe('a URL fragment', () => {
  it('does not end up inside the path param', () => {
    // `eventState.as` keeps the hash, and `imageId: '135356251#comments'` reaches
    // tRPC as the image id.
    const eventState = {
      as: '/images/135356251#comments',
      url: '/images/135356251#comments',
      state: {},
    };
    const result = resolveLocationChangeState(
      eventState,
      eventState,
      { pathname: '/images/135356251', search: '' },
      '/images/[imageId]'
    );
    expect(result.query.imageId).toBe(135356251);
  });

  it('does not end up on the last query param either', () => {
    // The query string is everything after `?`, fragment included, and it is
    // spread over the path params — so this shadowed the fix above.
    const eventState = {
      as: '/models/827184?modelVersionId=5#reviews',
      url: '/models/[id]?modelVersionId=5#reviews',
      state: {},
    };
    const result = resolveLocationChangeState(
      eventState,
      eventState,
      { pathname: '/models/827184', search: '?modelVersionId=5' },
      '/models/[id]'
    );
    expect(result.query.modelVersionId).toBe(5);
  });
});
