import { describe, expect, it } from 'vitest';
import { resolveLocationChangeState } from '~/components/BrowserRouter/browserRouterState';

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
      const historyState = { url: '/search?query=cats', as: '/search', state: { prev: { asPath: '/' } } };
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
});
