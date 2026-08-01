import { describe, it, expect } from 'vitest';
import {
  formatEmojiToken,
  isValidEmojiSlug,
  parseEmojiContent,
  resolveEmojiTokens,
} from '~/shared/utils/emoji-token';

const owned: Record<string, number> = { party_cat: 12, wave: 34 };
const resolve = (slug: string) => owned[slug];

describe('isValidEmojiSlug', () => {
  it('accepts lowercase alphanumeric + underscore, 2-32 chars', () => {
    expect(isValidEmojiSlug('party_cat')).toBe(true);
    expect(isValidEmojiSlug('a1')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isValidEmojiSlug('a')).toBe(false);
    expect(isValidEmojiSlug('Party')).toBe(false);
    expect(isValidEmojiSlug('party-cat')).toBe(false);
    expect(isValidEmojiSlug('x'.repeat(33))).toBe(false);
  });
});

describe('resolveEmojiTokens', () => {
  it('rewrites owned slugs to id tokens', () => {
    expect(resolveEmojiTokens('hi :party_cat: there', resolve)).toBe('hi :emoji:12: there');
  });

  it('leaves unowned slugs alone', () => {
    expect(resolveEmojiTokens('hi :nope: there', resolve)).toBe('hi :nope: there');
  });

  it('resolves multiple slugs including repeats', () => {
    expect(resolveEmojiTokens(':wave::wave::party_cat:', resolve)).toBe(
      ':emoji:34::emoji:34::emoji:12:'
    );
  });

  it('passes through already-resolved tokens', () => {
    expect(resolveEmojiTokens('a :emoji:99: b', resolve)).toBe('a :emoji:99: b');
  });

  it('leaves plain text with colons untouched', () => {
    expect(resolveEmojiTokens('12:30 - meeting', resolve)).toBe('12:30 - meeting');
  });
});

describe('parseEmojiContent', () => {
  it('returns a single text part when there are no tokens', () => {
    expect(parseEmojiContent('hello')).toEqual([{ type: 'text', value: 'hello' }]);
  });

  it('splits text around tokens', () => {
    expect(parseEmojiContent(`a ${formatEmojiToken(5)} b`)).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'emoji', cosmeticId: 5 },
      { type: 'text', value: ' b' },
    ]);
  });

  it('handles adjacent tokens and leading/trailing positions', () => {
    expect(parseEmojiContent(':emoji:1::emoji:2:')).toEqual([
      { type: 'emoji', cosmeticId: 1 },
      { type: 'emoji', cosmeticId: 2 },
    ]);
  });
});
