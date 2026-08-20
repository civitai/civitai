import { describe, expect, it } from 'vitest';
import { buildBenignPhraseRegex, stripBenignPhrasesWith } from '~/shared/utils/benign-phrases';
import { includesPoi } from '~/utils/metadata/audit';
import { createProfanityFilter, getProfanityFilter } from '~/libs/profanity-simple';

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

  // Each case is one the DETECTOR matches on the raw text, so the strip has real work to do.
  // A case the detector already misses (e.g. one whose punctuation its preprocessor deletes)
  // would pass here with no matcher at all — that is how the previous version of this test
  // was vacuous.
  it.each([
    'emma stone',
    'emma. stone',
    'emma,,,, stone',
    'emma  ,  stone',
    'emma____stone',
    'emma :: | stone',
  ])('agrees with the detector on %j, however many separators sit between the words', (text) => {
    expect(Boolean(includesPoi(text)), `${text} should trip the detector raw`).toBe(true);
    expect(includesPoi(strip(text, ['emma stone']))).toBe(false);
  });

  it('does not blank a longer word that merely contains the phrase', () => {
    expect(strip('stonemason', ['stone'])).toBe('stonemason');
  });

  // The gate this protects: the nsfw word list decides whether the POI and minor sub-checks
  // run at all, so swallowing the only nsfw signal in an input silences them rather than
  // merely hiding one term. `[^a-zA-Z0-9]` excludes only ASCII alphanumerics, so a non-ASCII
  // word is a separator to this pattern and a word to the detector.
  it('refuses to strip when the gap between the words holds a letter', () => {
    const withLetters = 'emma шок stone';
    expect(strip(withLetters, ['emma stone'])).toBe(withLetters);
  });

  // Letters are not the only thing a detection list holds: every entry surviving normalization
  // in `blocklist.json` is an emoji, carrying no `\p{L}` at all. Those are out of reach today
  // only because of which list `auditMetaData` selects on `nsfw === false` — a coincidence
  // between two files that do not reference each other.
  it.each([
    ['an emoji', 'emma \u{1F600} stone'],
    ['non-ASCII digits', 'emma १२ stone'],
  ])('refuses to strip when the gap holds %s', (_label, text) => {
    expect(strip(text, ['emma stone'])).toBe(text);
  });

  // …and the other half of that: non-ASCII PUNCTUATION is not content, so it must still strip.
  // A "whitespace or ASCII punctuation only" predicate would fail these two.
  it.each(['emma—stone', 'emma、stone'])(
    'CONTROL: still strips across the non-ASCII punctuation gap %j',
    (text) => {
      expect(strip(text, ['emma stone']).trim()).toBe('');
    }
  );

  it('CONTROL: the same shape with a punctuation-only gap still strips', () => {
    expect(strip('emma ,, stone', ['emma stone']).trim()).toBe('');
  });

  it('blanks the phrase for the ordinary separators a moderator would expect', () => {
    for (const text of ['emma stone', 'emma  stone', 'emma-stone', 'emma. stone']) {
      expect(strip(text, ['emma stone']).trim(), text).toBe('');
    }
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

  it('falls back to the static list when there is NO moderator row', () => {
    const filter = createProfanityFilter({ moderatorWhitelist: null });
    expect(filter.analyze('cockpit').isProfane).toBe(false);
  });

  // `[]` and `null` are different states and must not collapse: an empty row is a moderator
  // having deleted every entry, which is the strongest possible "do not whitelist" intent.
  // Restoring the ~450 shipped words over the top of that would be the opposite of the ask.
  it('honours an EMPTY moderator row instead of restoring the static list', () => {
    const filter = createProfanityFilter({ moderatorWhitelist: [] });
    expect(filter.analyze('cockpit').isProfane).toBe(true);
  });

  it('whitelisting one word does not disarm the filter for the token itself', () => {
    const filter = createProfanityFilter({ moderatorWhitelist: ['spreadsheet'] });
    expect(filter.analyze('spread').isProfane).toBe(true);
  });
});

// Every production caller goes through `getProfanityFilter`, not `createProfanityFilter`, and
// the null/empty distinction the tests above establish is decided by ITS cache key. Asserting
// the semantics one layer below where they are chosen leaves the key free to collapse them.
describe('getProfanityFilter keeps "no row" and "emptied" apart', () => {
  it('CONTROL: the same input returns the same shared instance', () => {
    expect(getProfanityFilter(['spreadsheet'])).toBe(getProfanityFilter(['spreadsheet']));
  });

  it('does not serve the no-row filter to a caller passing an empty list', () => {
    const noRow = getProfanityFilter(null);
    const emptied = getProfanityFilter([]);

    expect(emptied).not.toBe(noRow);
    // And they behave differently, which is the point of keeping them apart.
    expect(noRow.analyze('cockpit').isProfane).toBe(false);
    expect(emptied.analyze('cockpit').isProfane).toBe(true);
  });
});
