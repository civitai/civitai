import { describe, expect, it } from 'vitest';

import { tagDisplayName } from '~/utils/tag-display-name';

// The tag page uses this for its <title> and H1, so a tag whose stored name capitalises badly
// ("lora") must reach search results as the casing people recognise.
describe('tagDisplayName', () => {
  it('prefers the tag’s own display name', () => {
    expect(tagDisplayName({ name: 'lora', displayName: 'LoRA' })).toBe('LoRA');
  });

  it.each([
    [undefined, 'Anime'],
    [null, 'Anime'],
    ['', 'Anime'],
  ])('falls back to the capitalised name when displayName is %s', (displayName, expected) => {
    expect(tagDisplayName({ name: 'anime', displayName })).toBe(expected);
  });

  it.each([
    ['game character', 'Game Character'],
    ['warhammer 40,000', 'Warhammer 40,000'],
  ])('capitalises each word: %s → %s', (name, expected) => {
    expect(tagDisplayName({ name })).toBe(expected);
  });

  // What the fallback cannot reach is what the column is for.
  it('leaves a word starting with a digit alone', () => {
    expect(tagDisplayName({ name: '3d' })).toBe('3d');
    expect(tagDisplayName({ name: '3d', displayName: '3D' })).toBe('3D');
  });

  it('leaves scripts without case untouched', () => {
    expect(tagDisplayName({ name: '墨幽' })).toBe('墨幽');
  });

  it('survives repeated spaces', () => {
    expect(tagDisplayName({ name: 'big  love' })).toBe('Big  Love');
  });
});
