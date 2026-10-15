import { createHash } from 'crypto';

import {
  compareCodePoints,
  matchVocabularyKeys,
  TAG_GRAM_SIZES,
  TAG_MAX_SEGMENT_TOKENS,
  TAG_STOPWORDS,
  tagKeySets,
  tagSegments,
} from './extract';

/** The v1 content-tag arm's extractor constants, as the prototype mined and screened with them. */
export const RESOURCE_INTENT_TAGS_SPEC = {
  maxSegmentTokens: TAG_MAX_SEGMENT_TOKENS,
  gramSizes: TAG_GRAM_SIZES,
  stopwords: [...TAG_STOPWORDS].sort(compareCodePoints),
} as const;

/**
 * Synthetic prompts chosen so that each normalisation step with an observable effect changes their
 * output (the `\(` unescape has none: brackets become separators either way). They are also cases
 * of the prototype parity fixture, so the hashed behaviour is the prototype's.
 */
export const RESOURCE_INTENT_TAGS_FINGERPRINT_PROMPTS = [
  '<lora:Foo_Bar:0.8> (Watercolor Paintings:1.2), embedding:EasyNeg lighthouse BREAK dusk, breakfast, ébreak, été break',
  "\\(escaped\\) [puppies] {kitties}, close-up; sci-fi | x-ies. glasses! iris? 1990s 12345, gas, cactus, boss, -dash-, 'quoted, 𠀀ies",
  'a quiet mountain village with snowy roofs under the warm evening light',
  "the of and, Café au lait, ＦＵＬＬ, ΟΔΟΣ, ❶, ፩, rock'n'roll, under_score, हिन्दी",
  'glow:\t2.5 lamp, glow:\u{feff}2.5 lamp, glow:\u{1c}2.5 lamp, glow:\u{85}2.5 lamp',
  'embedding:neg\u{feff}word tail, embedding:neg\u{1c}word tail',
  '﨎 hall, 𠀀 gate, lighthouse, mountain village',
] as const;

const FINGERPRINT_VOCABULARY = [
  'lighthouse',
  'puppy',
  'mountain village',
  'snowy roof',
  '﨎 hall',
  '𠀀 gate',
];

/**
 * Hashes what the extractor produces on the fingerprint prompts, plus the constants. A behaviour
 * change those prompts do not exercise does not move it.
 */
function tagsFingerprint() {
  const vocabulary = new Set(FINGERPRINT_VOCABULARY);
  return {
    spec: RESOURCE_INTENT_TAGS_SPEC,
    out: RESOURCE_INTENT_TAGS_FINGERPRINT_PROMPTS.map((p) => {
      const { segment, gram } = tagKeySets(p);
      return {
        segments: tagSegments(p),
        segment: [...segment].sort(compareCodePoints),
        gram: [...gram].sort(compareCodePoints),
        matches: matchVocabularyKeys(p, vocabulary),
      };
    }),
  };
}

export const RESOURCE_INTENT_TAGS_SPEC_HASH = createHash('sha256')
  .update(JSON.stringify(tagsFingerprint()))
  .digest('hex');
