import { describe, it, expect } from 'vitest';
import { includesInappropriate, includesMinor, includesMinorAge } from '~/utils/metadata/audit';

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
