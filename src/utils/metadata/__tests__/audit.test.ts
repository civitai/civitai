import { describe, it, expect } from 'vitest';
import { includesMinorAge } from '~/utils/metadata/audit';

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
