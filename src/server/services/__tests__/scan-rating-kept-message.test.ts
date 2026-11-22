import { describe, expect, it } from 'vitest';
import { scanRatingKeptMessage } from '~/server/services/scan-rating-kept-message';

const version = (name: string) => ({ name, description: null, trainedWords: [] });
const sources = (versions: ReturnType<typeof version>[]) =>
  scanRatingKeptMessage({ name: 'Model', description: null, versions }).split('. It stays')[0];

describe('scanRatingKeptMessage', () => {
  it('names five versions and counts the rest', () => {
    expect(sources(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(version))).toBe(
      'This model is marked mature because of its text on civitai.red, which includes its title and the names of its published versions ("a", "b", "c", "d", "e", and 2 more)'
    );
  });

  it('shortens a long version name', () => {
    expect(sources([version(`${'x'.repeat(70)}`)])).toContain(`("${'x'.repeat(60)}…")`);
  });

  it('falls back to the model text when no field has any', () => {
    expect(scanRatingKeptMessage({ name: ' ', description: '<p></p>', versions: [] })).toMatch(
      /^This model is marked mature because of its text on civitai\.red\. It stays/
    );
  });
});
