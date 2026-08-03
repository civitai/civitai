import { describe, expect, it } from 'vitest';

import { humaniseScopeEndpoint } from '~/components/Apps/AppActivityPanel';

import { endpointBucketLabel } from '../endpoint-bucket-label';

/**
 * `topEndpoints` is an aggregate (GROUP BY endpoint + count). #3561 bounded the
 * endpoint column, which promoted the internal tokens to the TOP rows of the panel's
 * "Top endpoints" table, where they were rendered verbatim.
 *
 * Values pinned literally, derived from the recordScopeInvocation call sites — NOT
 * from the implementation — so a change to the label map has to be deliberate.
 */
describe('endpointBucketLabel — bounded tokens', () => {
  it.each([
    ['workflow:submit', 'Generation submits'],
    ['storage:set', 'App storage writes'],
    ['storage:delete', 'App storage deletes'],
    ['user-settings:write', 'User settings writes'],
  ])('%s -> %s', (endpoint, expected) => {
    expect(endpointBucketLabel(endpoint)).toBe(expected);
  });

  it('covers every endpoint value the server actually writes', () => {
    // Enumerated from `endpoint:` literals passed to recordScopeInvocation in
    // src/server (blocks.router.ts + apps.router.ts). If a new scoped write lands
    // without a label, this list is the reminder to add one.
    const written = ['workflow:submit', 'storage:set', 'storage:delete', 'user-settings:write'];
    for (const e of written) {
      expect(endpointBucketLabel(e)).not.toBe(e);
    }
  });
});

describe('endpointBucketLabel — legacy tailed buckets (no data migration was run)', () => {
  it('labels the operation and KEEPS the tail so two legacy buckets stay distinct', () => {
    expect(endpointBucketLabel('workflow:submit:wf_aaa')).toBe('Generation submits (wf_aaa)');
    expect(endpointBucketLabel('workflow:submit:wf_bbb')).toBe('Generation submits (wf_bbb)');
    // The whole point: distinct rows must not collapse to one identical label, which
    // would read as duplicate rows with unexplained separate counts.
    expect(endpointBucketLabel('workflow:submit:wf_aaa')).not.toBe(
      endpointBucketLabel('workflow:submit:wf_bbb')
    );
  });

  it("treats the historical 'pending' stand-in as just another tail", () => {
    expect(endpointBucketLabel('workflow:submit:pending')).toBe('Generation submits (pending)');
  });

  it('handles a storage key tail, including one containing colons', () => {
    expect(endpointBucketLabel('storage:set:my-key')).toBe('App storage writes (my-key)');
    expect(endpointBucketLabel('storage:delete:a:b')).toBe('App storage deletes (a:b)');
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
      '/api/v1/anything',
      'totally-unknown',
    ]) {
      expect(endpointBucketLabel(e)).not.toBe('');
    }
  });
});

/**
 * 🔴 WHY `humaniseScopeEndpoint` IS NOT REUSED HERE.
 *
 * It is exported from AppActivityPanel and looks like the obviously-right function,
 * so the next reader will ask — and the follow-up note that prompted this change
 * suggested exactly that. It is the per-ROW labeller: it resolves an operation's id
 * out of that row's `detail`, and an aggregate bucket has no `detail`.
 *
 * These assertions call the REAL function (not a copy) so they verify the claim rather
 * than restate it. Both of its no-detail outputs are worse than printing the raw
 * token, and one is an empty string that would render a blank table cell.
 *
 * If a change to that function makes these fail, re-read this decision rather than
 * deleting the test — the property being pinned is "the row labeller cannot serve the
 * aggregate", which is the reason two functions exist.
 */
describe('the per-row humaniser is unsuitable for an aggregate bucket', () => {
  it("would label the now-top-ranked 'workflow:submit' bucket '(no workflow id)'", () => {
    expect(humaniseScopeEndpoint('workflow:submit')).toBe('(no workflow id)');
    expect(endpointBucketLabel('workflow:submit')).toBe('Generation submits');
  });

  it("would render 'user-settings:write' as a BLANK cell", () => {
    expect(humaniseScopeEndpoint('user-settings:write')).toBe('');
    expect(endpointBucketLabel('user-settings:write')).toBe('User settings writes');
  });

  it('and for a bounded storage token it degrades to the bare token, adding nothing', () => {
    expect(humaniseScopeEndpoint('storage:set')).toBe('storage:set');
    expect(endpointBucketLabel('storage:set')).toBe('App storage writes');
  });
});
