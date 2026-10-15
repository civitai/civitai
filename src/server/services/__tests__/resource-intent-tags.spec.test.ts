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
    expect(new Set(stopwords).size).toBe(stopwords.length);
  });

  it('the spec hash is pinned: a change to the extractor or its constants must update this literal', () => {
    // Deliberately a literal: snapshots record the hash they were built under, so change it only
    // on purpose.
    expect(RESOURCE_INTENT_TAGS_SPEC_HASH).toBe(
      '0f929a738e24cfe31505da849cbd2fbfc6d443e7764b4fd9e16cd70d9fa7e699'
    );
  });
});
