import { describe, expect, it } from 'vitest';

import { parseChallengeMetadata } from '~/server/schema/challenge.schema';

/**
 * `parseChallengeMetadata` strips undeclared keys, and several call sites parse the metadata and
 * then write the parsed object straight back to the column. Any key written to Challenge.metadata
 * by raw SQL but missing from `challengeMetadataSchema` is therefore destroyed by the next such
 * rewrite.
 *
 * These two fields are written by raw jsonb merges and read back by SQL that never goes near zod,
 * so nothing else in the type system connects the write to the read. That is what makes a
 * round-trip test the only thing holding them in place.
 */
describe('parseChallengeMetadata round-trip', () => {
  it('preserves reviewedAt, the round-robin ordering key', () => {
    // Written as a bare JSON number by daily-challenge-processing, read via
    // `cast(metadata->>'reviewedAt' as bigint)`.
    const raw = { reviewedAt: 1753920000000 };

    expect(parseChallengeMetadata(raw).reviewedAt).toBe(1753920000000);
  });

  it('preserves completingClaimedAt, the completion claim stamp', () => {
    // Written as an ISO string by claimChallengeForCompletion; read by the stuck-challenge reset
    // and the claim-ownership check.
    const raw = { completingClaimedAt: '2026-07-30T00:03:00.000Z' };

    expect(parseChallengeMetadata(raw).completingClaimedAt).toBe('2026-07-30T00:03:00.000Z');
  });

  it('survives the parse-then-write-back cycle that strips undeclared keys', () => {
    // The shape that actually loses data in production: parse, then persist the parsed object.
    // `migratedAt` is here so the declaration that has no reader is still held in place by a test —
    // otherwise it could be deleted with a fully green suite, which is exactly the silent-drop this
    // schema exists to prevent.
    const stored = {
      challengeType: 'daily',
      articleId: 42,
      reviewedAt: 1753920000000,
      completingClaimedAt: '2026-07-30T00:03:00.000Z',
      migratedAt: '2026-05-01T00:00:00.000Z',
    };

    const afterRewrite = parseChallengeMetadata(parseChallengeMetadata(stored));

    expect(afterRewrite).toEqual(stored);
  });

  it('still drops genuinely unknown keys rather than widening the column', () => {
    const parsed = parseChallengeMetadata({ reviewedAt: 1, notARealField: 'nope' });

    expect(parsed.reviewedAt).toBe(1);
    expect(parsed).not.toHaveProperty('notARealField');
  });

  it('does not throw on a wrong-typed value — but loses the WHOLE object, siblings included', () => {
    // A bad value must not blow up a completion run. What it does instead is worse than the
    // one-key fixture this test used to carry would suggest: `parseChallengeMetadata` returns `{}`
    // for the entire object, and the call sites that write the parsed result back would persist
    // that — taking `reconciliation.paidUserIds` (which gates participation back-pay) with it.
    // Asserted with siblings present precisely so the blast radius is visible in the test, not just
    // in a comment. This is the cost of DECLARING a key: undeclared, a bad value is merely stripped
    // and its siblings survive.
    const withSiblings = {
      challengeType: 'daily',
      articleId: 42,
      reconciliation: { paidUserIds: [1, 2, 3] },
      reviewedAt: 'not-a-number',
    };

    expect(() => parseChallengeMetadata(withSiblings)).not.toThrow();
    expect(parseChallengeMetadata(withSiblings)).toEqual({});
  });
});
