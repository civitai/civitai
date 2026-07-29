import { describe, expect, it } from 'vitest';
import { getHistoryStateKey } from '~/store/clientHistoryState';

// Regression coverage for the Safari/iOS back-navigation crash:
//   TypeError: null is not an object (evaluating 't.state.key')
//     at src/store/ClientHistoryStore.tsx (popstate handler + setDefault)
// Safari delivers a `null` `history.state` / popstate `e.state` on some
// back/forward + bfcache restores; reading `.key` off it threw and broke the
// back button for iOS users. `getHistoryStateKey` is the shared guard the two
// call-sites (handlePopstate, the setDefault effect, getHasClientHistory) use.
describe('getHistoryStateKey', () => {
  describe('the Safari/iOS null case (the crash)', () => {
    it('returns undefined for null history.state / popstate e.state (no throw)', () => {
      expect(() => getHistoryStateKey(null)).not.toThrow();
      expect(getHistoryStateKey(null)).toBeUndefined();
    });

    it('returns undefined for undefined state', () => {
      expect(getHistoryStateKey(undefined)).toBeUndefined();
    });

    it('returns undefined for a state object with no key (bfcache-restored entry)', () => {
      expect(getHistoryStateKey({})).toBeUndefined();
      expect(getHistoryStateKey({ url: '/models', as: '/models' })).toBeUndefined();
    });

    it('returns undefined for a non-string / null key', () => {
      expect(getHistoryStateKey({ key: null })).toBeUndefined();
      expect(getHistoryStateKey({ key: 123 })).toBeUndefined();
      expect(getHistoryStateKey({ key: undefined })).toBeUndefined();
    });

    it('returns undefined for non-object state (primitive)', () => {
      expect(getHistoryStateKey('nope')).toBeUndefined();
      expect(getHistoryStateKey(42)).toBeUndefined();
    });
  });

  describe('the Chrome / happy path (unchanged)', () => {
    it('returns the string key when present (Next.js-populated state)', () => {
      expect(getHistoryStateKey({ key: 'abc123' })).toBe('abc123');
      expect(getHistoryStateKey({ key: 'k', url: '/models', as: '/models' })).toBe('k');
    });
  });
});
