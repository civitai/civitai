import { describe, expect, it } from 'vitest';
import { parseSubjectUserId } from '~/server/middleware/block-scope.middleware';
import {
  isSubjectScopedInstanceId,
  subjectForUserId,
} from '~/server/services/block-revocation.service';

/**
 * 🔴 THE WRITE SIDE AND THE READ SIDE SPELL THE SUBJECT SEPARATELY, AND NOTHING FORCED
 * THEM TO AGREE.
 *
 * The ban writer builds a subject with `subjectForUserId(userId)`; the guards pass
 * `claims.sub` verbatim off the token. If those two spellings ever diverge the
 * subject-scoped ban marker is written under a key nobody reads — the ban then refuses
 * NOBODY, silently, and every assertion that checks the key's own shape still passes
 * because both sides of that assertion come from the same half.
 *
 * `block-revocation.service.ts` claimed a suite already round-tripped this. It did not:
 * `subjectForUserId` appeared in exactly two files, neither of them a test. This is that
 * suite.
 */
describe('subjectForUserId round-trips through the read side’s parser', () => {
  it.each([1, 42, 555, 90618, 2147483647])('user %i', (userId) => {
    const sub = subjectForUserId(userId);
    expect(
      parseSubjectUserId(sub),
      `the ban writer mints the subject "${sub}", which the guards' own parser does not ` +
        'read back as the same user — a subject-scoped ban marker would be written under ' +
        'a key no request ever looks up, and the ban would refuse nobody'
    ).toBe(userId);
  });

  it('POSITIVE CONTROL: the parser rejects a spelling this function does not produce', () => {
    // Without this, a `parseSubjectUserId` that returned its input's digits regardless of
    // format would satisfy every case above while proving nothing about the format.
    expect(() => parseSubjectUserId('usr:42')).toThrow();
    expect(() => parseSubjectUserId('42')).toThrow();
  });

  it('the anon subject is not something this function can mint', () => {
    // `anon` parses to null rather than throwing, and no userId produces it — so an anon
    // token can never collide with a banned user's subject-scoped key.
    expect(parseSubjectUserId('anon')).toBeNull();
    expect([1, 42, 555].map(subjectForUserId)).not.toContain('anon');
  });
});

/**
 * The reader gates its third Redis GET on this predicate and the writer picks its keyspace
 * with it. They are the same function by construction; what can still rot is the SET of
 * shapes it answers true for, so the shapes are named here.
 */
describe('isSubjectScopedInstanceId', () => {
  it.each([
    ['page_ephemeral-demo', true, 'the one non-unique id — a developer-chosen slug'],
    ['page_ephemeral-my-app', true, 'hyphens in the slug are ordinary'],
    ['page_apb_01JEXAMPLE', false, 'derived from a unique AppBlock id'],
    ['page_pubreq_01JEXAMPLE', false, 'derived from a unique publish-request id'],
    ['page_pubreq_pubreq_01JEXAMPLE', false, 'ditto, double-prefixed'],
    ['page_local_my-app', false, 'uncovered by the writer entirely'],
    ['bus_pub_bus_01JEXAMPLE', false, 'derived from a unique subscription id'],
    ['bus_view_bus_01JEXAMPLE', false, ''],
    ['pdb_apb_01JEXAMPLE', false, ''],
    ['bki_01JEXAMPLE', false, ''],
    ['mbi_01JEXAMPLE', false, ''],
  ])('%s → %s', (id, expected) => {
    expect(isSubjectScopedInstanceId(id)).toBe(expected);
  });

  /**
   * 🔴 SCOPING MORE WOULD BE A SECURITY REGRESSION, not a refinement. Every id above that
   * answers false is derived from a globally unique row id and names exactly one app, and
   * its tokens are legitimately held by MANY viewers — all of whom a ban must refuse. A
   * subject-scoped marker there would refuse only the one holder who happened to trigger
   * it and serve everybody else.
   */
  it('scopes exactly one shape — widening it would un-revoke every other holder', () => {
    const scoped = [
      'page_ephemeral-demo',
      'page_apb_1',
      'page_pubreq_1',
      'page_pubreq_pubreq_1',
      'page_local_x',
      'bus_pub_1',
      'bus_view_1',
      'pdb_1',
      'bki_1',
      'mbi_1',
    ].filter(isSubjectScopedInstanceId);
    expect(scoped).toEqual(['page_ephemeral-demo']);
  });
});
