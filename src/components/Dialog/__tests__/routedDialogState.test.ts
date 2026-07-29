import { describe, expect, it } from 'vitest';
import { getRoutedDialogState } from '~/components/Dialog/routedDialogState';

// Regression coverage for the relocated Safari/iOS back-navigation crash:
//   TypeError: null is not an object (evaluating 't.state')
//     at src/components/Dialog/RoutedDialogProvider.tsx (the `?dialog=…` open path)
// Safari delivers a null `history.state` on some back/forward + bfcache restores;
// the routed-dialog effect read `history.state.state` (nested props to spread into
// the opened dialog) unguarded and threw. `getRoutedDialogState` is the shared
// guard the call-site now uses — it must degrade to `{}` (no extra props) rather
// than crash, matching the `?? {}` style used in resolveLocationChangeState.
describe('getRoutedDialogState', () => {
  describe('the Safari/iOS null case (the crash)', () => {
    it('returns {} for null history.state (no throw) — dialog opens with no extra props', () => {
      expect(() => getRoutedDialogState(null)).not.toThrow();
      expect(getRoutedDialogState(null)).toEqual({});
    });

    it('returns {} for undefined state', () => {
      expect(getRoutedDialogState(undefined)).toEqual({});
    });

    it('returns {} when history.state has no nested state (bfcache-restored entry)', () => {
      expect(getRoutedDialogState({})).toEqual({});
      expect(getRoutedDialogState({ url: '/models/1?dialog=imageDetail', as: '/images/1' })).toEqual({});
    });

    it('returns {} when nested state is null / not an object', () => {
      expect(getRoutedDialogState({ state: null })).toEqual({});
      expect(getRoutedDialogState({ state: 'nope' })).toEqual({});
      expect(getRoutedDialogState({ state: 42 })).toEqual({});
    });

    it('returns {} for a non-object history.state (primitive)', () => {
      expect(getRoutedDialogState('nope')).toEqual({});
    });
  });

  describe('the Chrome / happy path (unchanged)', () => {
    it('returns the nested state object when present (Next.js-populated state)', () => {
      const nested = { imageId: 123, postId: 45 };
      expect(getRoutedDialogState({ state: nested })).toBe(nested);
      expect(getRoutedDialogState({ url: '/x', as: '/x', state: { foo: 'bar' } })).toEqual({ foo: 'bar' });
    });
  });
});
