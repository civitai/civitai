import { describe, expect, it } from 'vitest';
import { buildBenignPhraseRegex, stripBenignPhrasesWith } from '~/shared/utils/benign-phrases';
import { includesPoi } from '~/utils/metadata/audit';
import { createProfanityFilter } from '~/libs/profanity-simple';

describe('benign phrases reach the client-side search gates', () => {
  const strip = (text: string, phrases: string[]) =>
    stripBenignPhrasesWith(text, buildBenignPhraseRegex(phrases));

  it('CONTROL: a POI name the moderator has NOT whitelisted still trips the search gate', () => {
    expect(includesPoi(strip('emma stone portrait', ['teen titans']))).toBe('emma stone');
  });

  it('a whitelisted phrase is blanked, so the search gate lets the query through', () => {
    expect(includesPoi(strip('emma stone portrait', ['emma stone']))).toBe(false);
  });

  it('leaves the rest of the query intact', () => {
    expect(strip('emma stone portrait', ['emma stone']).trim()).toBe('portrait');
  });

  it('matches a phrase whose words are joined by punctuation, as the server matcher does', () => {
    expect(includesPoi(strip('emma-stone portrait', ['emma stone']))).toBe(false);
  });

  it('does not blank a longer word that merely contains the phrase', () => {
    expect(strip('stonemason', ['stone'])).toBe('stonemason');
  });

  it('returns null for an empty list so callers can skip the replace', () => {
    expect(buildBenignPhraseRegex([])).toBeNull();
    expect(buildBenignPhraseRegex(['   '])).toBeNull();
  });
});

describe('moderator benign words reach the profanity filter', () => {
  it('CONTROL: without the moderator list, a word containing a profanity token is flagged', () => {
    expect(createProfanityFilter().analyze('spreadsheet').isProfane).toBe(true);
  });

  it('a moderator-whitelisted word is no longer flagged', () => {
    const filter = createProfanityFilter({ extraWhitelist: ['spreadsheet'] });
    expect(filter.analyze('spreadsheet').isProfane).toBe(false);
  });

  it('whitelisting one word does not disarm the filter for the token itself', () => {
    const filter = createProfanityFilter({ extraWhitelist: ['spreadsheet'] });
    expect(filter.analyze('spread').isProfane).toBe(true);
  });

  it('keeps the words shipped in the static list', () => {
    const filter = createProfanityFilter({ extraWhitelist: ['spreadsheet'] });
    expect(filter.analyze('analysis').isProfane).toBe(false);
  });
});
