import { englishDataset, englishRecommendedTransformers, RegExpMatcher } from 'obscenity';
import { describe, expect, it } from 'vitest';
import { blockedWords } from '@civitai/mod-utils/profanity/lists';
import { cleanWord, isUsableBlockedEntry } from '@civitai/mod-utils/profanity/word-rules';
import { createProfanityFilter } from '~/libs/profanity-simple';

// Synthetic tokens only: this file is public, and so is the list the shipped words come from.
const MANAGED = { version: '31:1', words: ['zorblat'] };

const shipped = createProfanityFilter();
const managed = createProfanityFilter({ moderatorBlocklist: MANAGED.words });

/**
 * Shipped entries the shipped filter flags but the library's own English dataset does not, found
 * WITHOUT the managed filter, so a merged list cannot empty this and pass quietly.
 */
const englishOnly = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});
const shippedOnly = blockedWords
  .filter(isUsableBlockedEntry)
  .map((word) => cleanWord(word).replace(/\|/g, ''))
  .filter((word) => shipped.analyze(word).isProfane && !englishOnly.hasMatch(word));

describe('a managed blocked list', () => {
  it('masks a word the shipped list does not carry', () => {
    expect(shipped.clean('a zorblat here')).toBe('a zorblat here');
    expect(managed.clean('a zorblat here')).not.toContain('zorblat');
  });

  it('REPLACES the shipped list, so removing a shipped word unmasks it', () => {
    expect(shippedOnly.length).toBeGreaterThan(0);
    // Failures name the entry's position, not the entry: CI logs are public.
    const stillFlagged = shippedOnly.flatMap((word, index) =>
      managed.analyze(word).isProfane ? [`shipped entry #${index}`] : []
    );
    expect(stillFlagged, 'the managed list was merged with the shipped one').toEqual([]);
  });
});
