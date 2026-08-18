import { describe, expect, it } from 'vitest';
import {
  isStoreVisibilityScope,
  narrowStoreScope,
  STORE_VISIBILITY_SCOPES,
} from '~/shared/utils/store-visibility-scope';

/**
 * The ONE narrowing rule the App-store read path applies to a possibly-absent scope
 * (civitai#3983). Every consumer — both `/api/v1/apps*` REST handlers, the store tRPC
 * branch point, and both listing-service entry points — routes through
 * `narrowStoreScope`, so this is the single place the fail-closed direction is pinned.
 *
 * The rule that matters is asymmetric and worth stating on its own: an uninterpretable
 * value must resolve to `none`, NEVER to `full` or `public-external`. The bug this
 * replaces was a `?? 'full'` — a default that silently issued the widest entitlement
 * in the system to whatever code path failed to supply an argument.
 */
describe('narrowStoreScope — an unrecognized scope resolves to `none`, never to access', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a wrong-cased scope', 'FULL'],
    ['a near-miss', 'public_external'],
    ['a scope from a hypothetical newer branch', 'public-onsite'],
    ['a number', 1],
    ['a boolean', true],
    ['an object', { scope: 'full' }],
    ['an array', ['full']],
    ['a Promise (an unawaited resolver call)', Promise.resolve('full')],
  ])('%s → none', (_label, value) => {
    expect(narrowStoreScope(value)).toBe('none');
  });

  it.each(STORE_VISIBILITY_SCOPES)('passes the real scope `%s` through unchanged', (scope) => {
    expect(narrowStoreScope(scope)).toBe(scope);
  });

  // The closed set is the contract; pin its exact membership so widening it becomes a
  // deliberate edit here rather than a silent consequence of a new branch elsewhere.
  it('the closed set is exactly full | public-external | none', () => {
    expect([...STORE_VISIBILITY_SCOPES]).toEqual(['full', 'public-external', 'none']);
  });

  it('isStoreVisibilityScope accepts every member and rejects everything else', () => {
    for (const scope of STORE_VISIBILITY_SCOPES) expect(isStoreVisibilityScope(scope)).toBe(true);
    for (const value of [undefined, null, '', 'FULL', 0, {}, []])
      expect(isStoreVisibilityScope(value)).toBe(false);
  });
});
