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
  it('CONTROL: with no moderator list, the static whitelist is in effect', () => {
    const filter = createProfanityFilter();
    // `spreadsheet` is not in the static list, so it is flagged for containing `spread`.
    expect(filter.analyze('spreadsheet').isProfane).toBe(true);
    // `cockpit` IS in the static list and IS rescued by it (verified: 49 of the 424 static
    // words are flagged without it, and this is one of them — most of the rest are already
    // covered by obscenity's own recommended whitelist, so picking an arbitrary static word
    // would have made this assertion vacuous).
    expect(filter.analyze('cockpit').isProfane).toBe(false);
  });

  it('a moderator-whitelisted word is no longer flagged', () => {
    const filter = createProfanityFilter({ moderatorWhitelist: ['spreadsheet'] });
    expect(filter.analyze('spreadsheet').isProfane).toBe(false);
  });

  // The point of REPLACING rather than unioning: a moderator can take a word OUT. Under a
  // union every static word stays whitelisted forever and the UI's Remove control is a
  // silent no-op, since the seed migration copies the static list verbatim.
  it('the moderator list REPLACES the static one, so removing an entry takes effect', () => {
    const filter = createProfanityFilter({ moderatorWhitelist: ['spreadsheet'] });
    expect(filter.analyze('cockpit').isProfane).toBe(true);
  });

  it('falls back to the static list when the moderator list is empty', () => {
    const filter = createProfanityFilter({ moderatorWhitelist: [] });
    expect(filter.analyze('cockpit').isProfane).toBe(false);
  });

  it('whitelisting one word does not disarm the filter for the token itself', () => {
    const filter = createProfanityFilter({ moderatorWhitelist: ['spreadsheet'] });
    expect(filter.analyze('spread').isProfane).toBe(true);
  });
});
