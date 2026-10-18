import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  RESOURCE_INTENT_TAGS_SPEC,
  RESOURCE_INTENT_TAGS_SPEC_HASH,
} from '~/server/services/resource-intent-tags/spec';

describe('RESOURCE_INTENT_TAGS_SPEC', () => {
  it('is the configuration the prototype mined, built and screened with', () => {
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
      build: {
        outcome: { genUserPrior: 10, postUserPrior: 5, tipBonus: 1, disliked: -1 },
        fit: {
          resourcePrior: 20,
          tagPrior: 10,
          ecosystemPrior: 10,
          fitExponent: 1,
          liftExponent: 0.5,
          relevancePrior: 5,
          minTagUsers: 2,
        },
        content: {
          minPrompts: 3,
          promptPrior: 3,
          minScore: 0.1,
          scoreDecimals: 4,
          weights: {
            showcase: 1,
            gallery: 0.6,
            tags: 0.8,
            trigger: 0.5,
            name: 0.8,
            description: 0.3,
          },
        },
        addonTypes: [
          'AestheticGradient',
          'CLIPVision',
          'Controlnet',
          'Detection',
          'DoRA',
          'Hypernetwork',
          'LORA',
          'LoCon',
          'Poses',
          'TextualInversion',
          'Upscaler',
        ],
      },
      sources: {
        trainDays: 90,
        gapDays: 1,
        genSliceMinutes: 2,
        postedMod: 6,
        content: {
          descriptionChars: 6000,
          versions: 4,
          showcasePerVersion: 12,
          galleryPostsPerVersion: 8,
        },
      },
      payloadFormat: 'resource-intent-tags/1',
    });
    expect(stopwords.length).toBe(140);
  });

  it('the spec hash is pinned: a change to the extractor, the build, the snapshot layout, the scorer or their constants must update this literal', () => {
    // Deliberately a literal: snapshots record the hash they were built under, so change it only
    // on purpose.
    expect(RESOURCE_INTENT_TAGS_SPEC_HASH).toBe(
      '96c0759fb1859a15ea616fda7013c503c2b20bf41bdf0f480769f96457380589'
    );
  });
});
