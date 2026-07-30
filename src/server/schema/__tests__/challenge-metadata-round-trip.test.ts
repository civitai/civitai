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
    const stored = {
      challengeType: 'daily',
      articleId: 42,
      reviewedAt: 1753920000000,
      completingClaimedAt: '2026-07-30T00:03:00.000Z',
    };

    const afterRewrite = parseChallengeMetadata(parseChallengeMetadata(stored));

    expect(afterRewrite).toEqual(stored);
  });

  it('still drops genuinely unknown keys rather than widening the column', () => {
    const parsed = parseChallengeMetadata({ reviewedAt: 1, notARealField: 'nope' });

    expect(parsed.reviewedAt).toBe(1);
    expect(parsed).not.toHaveProperty('notARealField');
  });

  it('ignores a wrong-typed value instead of throwing', () => {
    // A bad value must not blow up a completion run; the whole parse falls back to {}.
    expect(() => parseChallengeMetadata({ reviewedAt: 'not-a-number' })).not.toThrow();
    expect(parseChallengeMetadata({ reviewedAt: 'not-a-number' })).toEqual({});
  });
});
