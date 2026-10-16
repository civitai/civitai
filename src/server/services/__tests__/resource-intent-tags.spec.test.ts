import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  RESOURCE_INTENT_TAGS_SPEC,
  RESOURCE_INTENT_TAGS_SPEC_HASH,
} from '~/server/services/resource-intent-tags/spec';

describe('RESOURCE_INTENT_TAGS_SPEC', () => {
  it('is the configuration the prototype mined and screened with', () => {
    const { stopwords, ...rest } = RESOURCE_INTENT_TAGS_SPEC;
    expect(rest).toEqual({
      maxSegmentTokens: 4,
      gramSizes: [1, 2, 3],
      score: {
        fitExponent: 1,
        userWeight: 0.05,
        popularityWeight: 0.02,
        userEcosystemWeight: 0.05,
        maxCandidates: 300,
        liftPrior: 50,
        ecosystemMinUsers: 100,
        ecosystemsReturned: 3,
      },
      matureLevels: NsfwLevel.R | NsfwLevel.X | NsfwLevel.XXX,
    });
    expect(stopwords.length).toBe(140);
  });

  it('the spec hash is pinned: a change to the extractor, the scorer or their constants must update this literal', () => {
    // Deliberately a literal: snapshots record the hash they were built under, so change it only
    // on purpose.
    expect(RESOURCE_INTENT_TAGS_SPEC_HASH).toBe(
      '94fbe7749cb1573b2f7bc6eec766b949acfa98235e92fd8df74fb33bd46f617a'
    );
  });
});
