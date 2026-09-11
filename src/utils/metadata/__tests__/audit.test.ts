import { describe, it, expect } from 'vitest';
import {
  includesInappropriate,
  includesMinor,
  includesMinorAge,
  includesPoi,
} from '~/utils/metadata/audit';

describe('includesMinorAge', () => {
  describe('danbooru/pony tag false positives', () => {
    it('score_N followed by year tag should not flag', () => {
      for (let n = 1; n <= 9; n++) {
        const prompt = `score_${n}, year 2025`;
        expect(includesMinorAge(prompt), prompt).toEqual({ found: false, age: undefined });
      }
    });

    it('score_N_up / score_N_down variants should not flag', () => {
      expect(includesMinorAge('score_9_up, year 2025')).toEqual({ found: false, age: undefined });
      expect(includesMinorAge('score_5_down, year 2025')).toEqual({ found: false, age: undefined });
    });

    it('full pony-style prompt should not flag', () => {
      const prompt =
        'score_9, score_8_up, score_7_up, source_pony, rating_safe, year 2025, masterpiece, best quality';
      expect(includesMinorAge(prompt)).toEqual({ found: false, age: undefined });
    });

    it('source_* and rating_* tags adjacent to year should not flag', () => {
      expect(includesMinorAge('source_pony, year 2025')).toEqual({ found: false, age: undefined });
      expect(includesMinorAge('rating_safe, year 2025')).toEqual({ found: false, age: undefined });
    });
  });

  describe('prompt attention-weight false positives', () => {
    it('decimal weight digit adjacent to year should not flag', () => {
      expect(includesMinorAge('(@ningen mame:0.8), year')).toEqual({
        found: false,
        age: undefined,
      });
    });

    it('assorted decimal weights adjacent to year do not flag', () => {
      expect(includesMinorAge('(masterpiece:0.8), (best quality:1.2), year 2025')).toEqual({
        found: false,
        age: undefined,
      });
    });

    it('a real age inside a weighted group is still detected', () => {
      expect(includesMinorAge('(8 year old:1.2)')).toEqual({ found: true, age: 8 });
      expect(includesMinorAge('(loli:1.2), 8 year old')).toEqual({ found: true, age: 8 });
    });
  });

  describe('legitimate minor detection is preserved', () => {
    it('N year old phrasing', () => {
      expect(includesMinorAge('9 year old girl')).toEqual({ found: true, age: 9 });
      expect(includesMinorAge('a 15 year old')).toEqual({ found: true, age: 15 });
    });

    it('aged N', () => {
      expect(includesMinorAge('aged 15')).toEqual({ found: true, age: 15 });
    });

    it('teen spellings', () => {
      expect(includesMinorAge('seventeen year old')).toEqual({ found: true, age: 17 });
    });

    it('N yo shorthand', () => {
      expect(includesMinorAge('a 12 yo')).toEqual({ found: true, age: 12 });
    });

    it('score tag does not mask a real age phrase in the same prompt', () => {
      expect(includesMinorAge('score_9, a 9 year old girl')).toEqual({ found: true, age: 9 });
    });
  });

  describe('benign prompts remain benign', () => {
    it('empty prompt', () => {
      expect(includesMinorAge('')).toEqual({ found: false, age: undefined });
      expect(includesMinorAge(undefined)).toEqual({ found: false, age: undefined });
    });

    it('year tag alone', () => {
      expect(includesMinorAge('year 2025, masterpiece')).toEqual({ found: false, age: undefined });
    });

    it('resolution quality tags', () => {
      expect(includesMinorAge('8K, 4K, masterpiece, year 2025')).toEqual({
        found: false,
        age: undefined,
      });
    });
  });
});

// Benign-phrase neutralization (teen titans / minor barrel distortion / mature content)
// lives in the moderator blocklist store now, not in these pure functions — its coverage
// is in blocklist.service.test.ts. These tests pin the detection logic that stays here.
describe('negative-prompt minor detection', () => {
  it('flags genuine minor-steering negative nouns', () => {
    expect(includesMinor('a woman', 'mature body')).toBeTruthy();
    expect(includesMinor('a woman', 'adult body')).toBeTruthy();
    expect(includesMinor('a woman', 'mature')).toBeTruthy();
  });
});

describe('young-word anchoring (minor-review queue)', () => {
  it('does not flag the "minor" substring inside longer words', () => {
    // "minora"/"minority"/"Minoru" contain "minor" but are not minor references.
    for (const prompt of ['labia majora and minora', 'a large minority group', 'Minoru Suzuki']) {
      expect(includesInappropriate({ prompt }, true), prompt).toBe(false);
    }
  });

  it('still flags whole-word minor signals', () => {
    for (const prompt of [
      'nude teen',
      'a teenage girl at the park',
      'underage minor girl',
      'young schoolgirl',
      '1girl is child, nude, and wearing school swimsuit',
    ]) {
      expect(includesInappropriate({ prompt }, true), prompt).toBe('minor');
    }
  });
});

// Added under a rightsholder obligation, not as ordinary blocklist tuning. Do not delete
// these entries or this test without confirming with a maintainer that the obligation is
// discharged elsewhere.
describe('POI — Diddl character names', () => {
  const diddlNames = [
    'diddl',
    'diddlina',
    'pimboli',
    'loupsily',
    'galupy',
    'wollywell',
    'simsaly',
    'lollilovebear',
    'mimihopps',
    'ackaturbo',
    'vanillivi',
    'bibombl',
    'milimits',
    'tiplitaps',
    'diddldaddl',
    'blubberpeng',
    // The merchandise is branded "Diddl Maus". The poi preprocessor DELETES `-` rather than
    // splitting on it, so `diddl-maus` arrives as one token that `diddl` cannot match.
    'diddlmaus',
  ];

  it('blocks each name', () => {
    for (const name of diddlNames) {
      expect(includesPoi(`a drawing of ${name}, pastel colours`), name).toBe(name);
    }
  });

  // POI is a hard block with no user override, so a name matching inside a longer word is an
  // unappealable false positive. Every control below really does contain `diddl`; only that
  // entry is short enough to occur inside English words, so the others would assert nothing.
  it('does not block longer real words that contain a name', () => {
    for (const prompt of [
      'diddley bow, blues guitar',
      'diddling with the exposure slider',
      'a paradiddle drum pattern',
    ]) {
      expect(includesPoi(prompt), prompt).toBe(false);
    }
  });
});
