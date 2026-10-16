import { describe, expect, it } from 'vitest';
import {
  RESOURCE_INTENT_TAGS_SPEC,
  RESOURCE_INTENT_TAGS_SPEC_HASH,
} from '~/server/services/resource-intent-tags/spec';

describe('RESOURCE_INTENT_TAGS_SPEC', () => {
  it('is the configuration the prototype mined and screened with', () => {
    const { stopwords, ...rest } = RESOURCE_INTENT_TAGS_SPEC;
    expect(rest).toEqual({ maxSegmentTokens: 4, gramSizes: [1, 2, 3] });
    expect(stopwords.length).toBe(140);
  });

  it('the spec hash is pinned: a change to the extractor or its constants must update this literal', () => {
    // Deliberately a literal: snapshots record the hash they were built under, so change it only
    // on purpose.
    expect(RESOURCE_INTENT_TAGS_SPEC_HASH).toBe(
      '59f7737ccf6acbe88988b068be4c8600f8581a786e9764eeaf9f902f9cfc8ecc'
    );
  });
});
