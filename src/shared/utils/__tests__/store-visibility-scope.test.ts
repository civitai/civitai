import { describe, expect, it } from 'vitest';
import {
  isStoreVisibilityScope,
  narrowStoreScope,
  storeScopeRank,
  STORE_VISIBILITY_SCOPE_RANK,
  STORE_VISIBILITY_SCOPES,
  widerStoreScope,
  type StoreVisibilityScope,
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

/**
 * The BREADTH ORDERING (civitai#4048). The bug it replaces was a call site standing
 * in a hardcoded `scope !== 'none'` for "at least as wide as the public floor": it
 * short-circuited `public-external` — a NARROWER scope — past a grant that would have
 * widened it, so signing in REDUCED what a public REST endpoint returned.
 *
 * These tests pin the ordering as an ALGEBRA rather than as three remembered
 * comparisons, because the property the call sites rely on is algebraic: a floor
 * applied with {@link widerStoreScope} can only ever LIFT.
 */
describe('the scope breadth ordering: none ⊂ public-external ⊂ full', () => {
  const ALL = STORE_VISIBILITY_SCOPES;

  it('ranks the closed set in exactly subset order', () => {
    expect(storeScopeRank('none')).toBeLessThan(storeScopeRank('public-external'));
    expect(storeScopeRank('public-external')).toBeLessThan(storeScopeRank('full'));
  });

  // 🔴 widerStoreScope is commutative ONLY because equal ranks imply equal scopes.
  // Two scopes sharing a rank would silently make it return whichever came first, so
  // the injectivity is a load-bearing property, not a coincidence of the literals.
  it('the ranks are DISTINCT (what makes the tie-break case unreachable)', () => {
    const ranks = ALL.map((s) => STORE_VISIBILITY_SCOPE_RANK[s]);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('the rank map covers the closed set exactly — no extra key, no missing key', () => {
    expect(Object.keys(STORE_VISIBILITY_SCOPE_RANK).sort()).toEqual([...ALL].sort());
  });

  it('is TOTAL over the closed set: all 9 pairs return a member of the set', () => {
    let pairs = 0;
    for (const a of ALL)
      for (const b of ALL) {
        pairs++;
        expect(isStoreVisibilityScope(widerStoreScope(a, b))).toBe(true);
      }
    expect(pairs).toBe(9);
  });

  it('is COMMUTATIVE over all 9 pairs', () => {
    for (const a of ALL)
      for (const b of ALL) expect(widerStoreScope(a, b), `${a}/${b}`).toBe(widerStoreScope(b, a));
  });

  it('is IDEMPOTENT and ASSOCIATIVE', () => {
    for (const a of ALL) expect(widerStoreScope(a, a)).toBe(a);
    for (const a of ALL)
      for (const b of ALL)
        for (const c of ALL)
          expect(widerStoreScope(widerStoreScope(a, b), c), `${a}/${b}/${c}`).toBe(
            widerStoreScope(a, widerStoreScope(b, c))
          );
  });

  // The property every caller actually depends on, asserted directly rather than
  // inferred from the table below: applying a floor NEVER narrows either operand.
  it('🔴 NEVER NARROWS: the result is at least as wide as BOTH operands', () => {
    for (const a of ALL)
      for (const b of ALL) {
        const w = widerStoreScope(a, b);
        expect(storeScopeRank(w), `${a}/${b}`).toBeGreaterThanOrEqual(storeScopeRank(a));
        expect(storeScopeRank(w), `${a}/${b}`).toBeGreaterThanOrEqual(storeScopeRank(b));
      }
  });

  // And the literal table, so an inverted rank map cannot pass every algebraic law
  // above (it would: reversing the order preserves totality, commutativity,
  // associativity and idempotence — only the DIRECTION changes).
  it.each([
    ['none', 'none', 'none'],
    ['none', 'public-external', 'public-external'],
    ['none', 'full', 'full'],
    ['public-external', 'public-external', 'public-external'],
    ['public-external', 'full', 'full'],
    ['full', 'full', 'full'],
  ] as [StoreVisibilityScope, StoreVisibilityScope, StoreVisibilityScope][])(
    'wider(%s, %s) === %s',
    (a, b, expected) => {
      expect(widerStoreScope(a, b)).toBe(expected);
      expect(widerStoreScope(b, a)).toBe(expected);
    }
  );
});
