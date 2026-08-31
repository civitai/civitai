import { describe, expect, it } from 'vitest';

import { humaniseScopeEndpoint, humaniseScopeInvocation } from '~/components/Apps/AppActivityPanel';
import { READ_SCOPE_LABELS } from '~/shared/constants/block-action-detail';

import { endpointBucketLabel, scopeBucketLabel } from '../analytics-bucket-labels';

/**
 * Values pinned LITERALLY, derived from the recordScopeInvocation call sites and from the
 * Activity tab's existing vocabulary — never from the implementation under test.
 */
describe('endpointBucketLabel — bounded tokens', () => {
  it.each([
    ['workflow:submit', 'Generations'],
    ['storage:set', 'App-local storage writes'],
    ['storage:delete', 'App-local storage deletes'],
    ['user-settings:write', 'Block settings saves'],
  ])('%s -> %s', (endpoint, expected) => {
    expect(endpointBucketLabel(endpoint)).toBe(expected);
  });
});

describe('endpointBucketLabel — legacy tailed buckets (no data migration was run)', () => {
  it('labels the operation and KEEPS the tail so two legacy buckets stay distinct', () => {
    expect(endpointBucketLabel('workflow:submit:wf_aaa')).toBe('Generations (wf_aaa)');
    expect(endpointBucketLabel('workflow:submit:wf_bbb')).toBe('Generations (wf_bbb)');
    // The point: distinct rows must not collapse to one identical label, which would read
    // as duplicate rows with unexplained separate counts.
    expect(endpointBucketLabel('workflow:submit:wf_aaa')).not.toBe(
      endpointBucketLabel('workflow:submit:wf_bbb')
    );
  });

  it('handles a storage key tail, including one containing colons', () => {
    expect(endpointBucketLabel('storage:set:my-key')).toBe('App-local storage writes (my-key)');
    expect(endpointBucketLabel('storage:delete:a:b')).toBe('App-local storage deletes (a:b)');
  });

  /**
   * 🔴 `pending` is a "no id captured at write time" sentinel — it never encoded STATUS.
   * Pre-#3561 the writer was `workflow:submit:${snapshot.workflowId || 'pending'}`.
   *
   * Careful about the reason: such a row genuinely might have been in flight
   * (`snapshot.status` can be 'pending' and still writes a 200), so the objection is NOT
   * "pending is factually wrong about status" — it is that reusing the word implies the
   * field carried status information, which it did not. `(no id)` asserts nothing about
   * status. The row-level humaniser carves out the same sentinel (asserted below).
   */
  it('does NOT surface the `pending` sentinel as if it were an id or a status', () => {
    expect(endpointBucketLabel('workflow:submit:pending')).toBe('Generations (no id)');
    expect(endpointBucketLabel('workflow:submit:pending')).not.toContain('pending');
  });
});

describe('endpointBucketLabel — pass-through', () => {
  it('leaves a REST path from normalizeEndpoint alone', () => {
    expect(endpointBucketLabel('/api/v1/blocks/submissions')).toBe('/api/v1/blocks/submissions');
    expect(endpointBucketLabel('/api/v1/images/:id')).toBe('/api/v1/images/:id');
  });

  it('never returns an empty string for a non-empty input', () => {
    for (const e of [
      'workflow:submit',
      'user-settings:write',
      'storage:set:k',
      '/api/v1/x',
      'zz',
    ]) {
      expect(endpointBucketLabel(e)).not.toBe('');
    }
  });

  /**
   * The label lookup must not be prototype-reachable. With a plain object index,
   * `labels['constructor']` returns a FUNCTION, the truthy check passes, and React is
   * handed a non-string child — which throws and takes out the whole panel. Not reachable
   * from any current writer (non-literal values all come from `normalizeEndpoint` and
   * contain a `/`), so this pins the type signature's honesty, not a live bug.
   */
  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
    'returns a plain string for the prototype key %s',
    (key) => {
      expect(typeof endpointBucketLabel(key)).toBe('string');
      expect(endpointBucketLabel(key)).toBe(key);
    }
  );
});

describe('scopeBucketLabel', () => {
  it.each([
    ['ai:write:budgeted', 'AI workflow submits'],
    ['apps:storage', 'App-local storage calls'],
    ['apps:storage:shared:write', 'Shared storage writes'],
    ['collections:write:self', 'Collection updates'],
    ['(any-token)', 'Any-token routes (no scope required)'],
  ])('%s -> %s', (scope, expected) => {
    expect(scopeBucketLabel(scope)).toBe(expected);
  });

  /**
   * The two settings-write scopes are the SAME operation (`block:settings:write` is the
   * pre-#3212 name) and arrive as SEPARATE buckets with separate counts. They must not
   * share one label — two visually identical rows with different numbers is exactly what
   * the endpoint card's legacy-tail handling avoids, and the two halves of this module
   * must not hold opposite policies.
   */
  it('disambiguates the legacy settings-write scope from the current one', () => {
    expect(scopeBucketLabel('user-settings:write')).toBe('Block settings saves');
    expect(scopeBucketLabel('block:settings:write')).toBe('Block settings saves (legacy scope)');
    expect(scopeBucketLabel('user-settings:write')).not.toBe(
      scopeBucketLabel('block:settings:write')
    );
  });

  it('takes read labels from the SHARED registry, not a fourth private copy', () => {
    // Pin the identity, not merely "it changed" — a hardcoded duplicate in
    // WRITE_SCOPE_LABELS would also satisfy `not.toBe(raw)`, so that assertion could not
    // see what its comment claimed.
    expect(scopeBucketLabel('buzz:read:self')).toBe(READ_SCOPE_LABELS['buzz:read:self']);
    expect(scopeBucketLabel('user:read:self')).toBe(READ_SCOPE_LABELS['user:read:self']);
    expect(scopeBucketLabel('apps:storage:shared:read')).toBe(
      READ_SCOPE_LABELS['apps:storage:shared:read']
    );
  });

  it('passes a genuinely unmapped scope through rather than guessing', () => {
    // A shape no writer produces. (`publisher_all_my_models` would be a misleading
    // example: it is an ATTRIBUTION scope and never reaches this card at all.)
    expect(scopeBucketLabel('some:future:scope')).toBe('some:future:scope');
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'returns a plain string for the prototype key %s',
    (key) => {
      expect(typeof scopeBucketLabel(key)).toBe('string');
      expect(scopeBucketLabel(key)).toBe(key);
    }
  );
});

/**
 * 🔴 WHY THE ACTIVITY PANEL'S LABELLERS ARE NOT REUSED.
 *
 * `humaniseScopeInvocation` is the genuine near-duplicate — prefix-based, needs no
 * `detail`, already maps all four endpoint tokens — so it is what a reader will reach for.
 * These assertions call the REAL functions so the reasoning is verified, not restated.
 */
describe('the Activity panel labellers cannot serve an aggregate card', () => {
  it('humaniseScopeInvocation is the wrong REGISTER for a count column', () => {
    // A single past event, not a countable noun: "Generated an image — 245" does not read.
    expect(humaniseScopeInvocation('ai:write:budgeted', 'workflow:submit')).toBe(
      'Generated an image'
    );
    expect(endpointBucketLabel('workflow:submit')).toBe('Generations');
  });

  it('humaniseScopeInvocation has NO arm for a REST path, a large share of this card', () => {
    // Falls through to its scope→label map; with no meaningful scope that is a blank cell,
    // which is strictly worse than showing the path.
    expect(humaniseScopeInvocation('', '/api/v1/blocks/submissions')).toBe('');
    expect(endpointBucketLabel('/api/v1/blocks/submissions')).toBe('/api/v1/blocks/submissions');
  });

  it('humaniseScopeEndpoint resolves a per-ROW id an aggregate bucket does not have', () => {
    expect(humaniseScopeEndpoint('workflow:submit')).toBe('(no workflow id)');
    expect(humaniseScopeEndpoint('user-settings:write')).toBe('');
  });

  it('humaniseScopeInvocation had the SAME prototype hazard, now guarded too', () => {
    // It shares READ_SCOPE_LABELS with us, and `??` does not reject a non-nullish
    // prototype hit — this used to return Object.prototype.constructor (a function).
    for (const key of ['constructor', 'toString', 'valueOf']) {
      expect(typeof humaniseScopeInvocation(key)).toBe('string');
      expect(humaniseScopeInvocation(key)).toBe(key);
    }
  });

  it('and it agrees with us that `pending` is not an id', () => {
    // The shared premise behind our `(no id)` label — if this ever changes, revisit both.
    expect(humaniseScopeEndpoint('workflow:submit:pending')).toBe('(no workflow id)');
  });
});
