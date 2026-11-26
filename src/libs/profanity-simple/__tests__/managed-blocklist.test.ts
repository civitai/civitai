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

// The library's own English phrases, by their original words: the set a managed list replaces.
const libraryWords = [
  ...new Set(
    (
      englishDataset as unknown as { containers: { metadata?: { originalWord?: string } }[] }
    ).containers
      .map((container) => container.metadata?.originalWord)
      .filter((word): word is string => !!word)
  ),
].filter((word) => englishOnly.hasMatch(word));

/**
 * Deliberate: with a managed list, the moderators' list is the only source of blocked words, and
 * the library's English dataset is not loaded. Before deleting this, read why: the library list
 * could not be edited and carried substring over-matches no moderator could remove (civitai/civitai#10526).
 */
describe('a managed list replaces the library dataset too', () => {
  it('flags no library word the managed list does not carry', () => {
    expect(libraryWords.length).toBeGreaterThan(0);
    const stillFlagged = libraryWords.flatMap((word, index) =>
      managed.analyze(word).isProfane ? [`library word #${index}`] : []
    );
    expect(stillFlagged, 'the library dataset was loaded with a managed list').toEqual([]);
  });

  it('keeps the library dataset with the shipped list, the fallback', () => {
    const missed = libraryWords.flatMap((word, index) =>
      shipped.analyze(word).isProfane ? [] : [`library word #${index}`]
    );
    expect(missed, 'the shipped list lost the library dataset').toEqual([]);
    const unset = createProfanityFilter({ moderatorBlocklist: undefined });
    expect(libraryWords.filter((word) => !unset.analyze(word).isProfane)).toEqual([]);
  });

  it('stops the library over-matches on ordinary words', () => {
    const managedShipped = createProfanityFilter({ moderatorBlocklist: [...blockedWords] });
    for (const word of ['Fukorou', 'Shitori']) {
      expect(shipped.analyze(word).isProfane, word).toBe(true);
      expect(managedShipped.analyze(word).isProfane, word).toBe(false);
    }
  });
});
