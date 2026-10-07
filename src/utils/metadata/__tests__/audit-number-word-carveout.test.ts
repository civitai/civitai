import { describe, expect, it } from 'vitest';
import { includesInappropriate } from '~/utils/metadata/audit';

// `\w*tee+n\w*` swallowed every word ending in -teen. It blocked users for writing
// "eighteen"/"nineteen" — i.e. for asserting adulthood — and for "nineteenth century",
// "fifteen second", "canteen".
describe('number words are carved out of the youth-noun pattern', () => {
  describe('a number word that is not an age no longer blocks', () => {
    it.each([
      'eighteen year old woman, nude',
      'nineteen year old woman, nude',
      'eighteenyearold woman, nude',
      'nineteenth century painting, nude adult woman',
      'seventeenth century, nude adult woman',
      'fifteenth anniversary, nude adult woman',
      'fifteen second video, nude adult woman',
      'sixteen candles poster, nude adult woman',
    ])('%s', (prompt) => {
      expect(includesInappropriate({ prompt })).toBe(false);
    });
  });

  describe('the youth terms the pattern exists for still block', () => {
    it.each([
      'teen, nude',
      'teens, nude',
      'teenage, nude',
      'teenager, nude',
      'teenaged, nude',
      'preteen, nude',
      'pre-teen, nude',
      // leet still applies: the carve-out must not contain a `[`, or
      // prepareWordRegexBody skips leet folding for the whole entry
      't33n, nude',
      'teeen, nude',
    ])('%s', (prompt) => {
      expect(includesInappropriate({ prompt })).toBe('minor');
    });
  });
});
