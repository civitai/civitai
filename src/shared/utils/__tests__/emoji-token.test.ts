import { describe, it, expect } from 'vitest';
import {
  EMOJI_JUMBO_LIMIT,
  formatEmojiToken,
  isValidEmojiSlug,
  parseEmojiContent,
  parseEmojiIds,
  parseEmojiLines,
  resolveEmojiTokens,
  stripEmojiTokens,
} from '~/shared/utils/emoji-token';

const owned: Record<string, number> = { party_cat: 12, wave: 34 };
const resolveSlug = (slug: string) => owned[slug];
const isOwnedId = (id: number) => Object.values(owned).includes(id);

describe('isValidEmojiSlug', () => {
  it('accepts lowercase alphanumeric + underscore, 2-32 chars', () => {
    expect(isValidEmojiSlug('party_cat')).toBe(true);
    expect(isValidEmojiSlug('a1')).toBe(true);
    expect(isValidEmojiSlug('123abc')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isValidEmojiSlug('a')).toBe(false);
    expect(isValidEmojiSlug('Party')).toBe(false);
    expect(isValidEmojiSlug('party-cat')).toBe(false);
    expect(isValidEmojiSlug('x'.repeat(33))).toBe(false);
  });

  it('rejects all-digit slugs so clock times are not emoji', () => {
    expect(isValidEmojiSlug('30')).toBe(false);
    expect(isValidEmojiSlug('1234')).toBe(false);
  });
});

describe('resolveEmojiTokens', () => {
  it('rewrites owned slugs to id tokens', () => {
    expect(resolveEmojiTokens('hi :party_cat: there', { resolveSlug })).toBe('hi :emoji:12: there');
  });

  it('leaves unowned slugs alone', () => {
    expect(resolveEmojiTokens('hi :nope: there', { resolveSlug })).toBe('hi :nope: there');
  });

  it('resolves multiple slugs including repeats', () => {
    expect(resolveEmojiTokens(':wave::wave::party_cat:', { resolveSlug })).toBe(
      ':emoji:34::emoji:34::emoji:12:'
    );
  });

  it('leaves clock times untouched', () => {
    expect(resolveEmojiTokens('Meeting at 12:30: see you', { resolveSlug })).toBe(
      'Meeting at 12:30: see you'
    );
  });

  it('without an ownership gate, passes raw tokens through for optimistic render', () => {
    expect(resolveEmojiTokens('a :emoji:99: b', { resolveSlug })).toBe('a :emoji:99: b');
  });

  it('deletes tokens the sender does not own', () => {
    expect(resolveEmojiTokens('a :emoji:99: b', { resolveSlug, isOwnedId })).toBe('a  b');
  });

  it('keeps tokens the sender owns', () => {
    expect(resolveEmojiTokens('a :emoji:12: b', { resolveSlug, isOwnedId })).toBe('a :emoji:12: b');
  });

  it('deleting an unowned token rejoins the text so blocklists still match', () => {
    expect(stripEmojiTokens(resolveEmojiTokens('fu:emoji:99:ck', { resolveSlug, isOwnedId }))).toBe(
      'fuck'
    );
  });
});

describe('stripEmojiTokens', () => {
  it('rejoins text split by an owned token', () => {
    expect(stripEmojiTokens('fu:emoji:12:ck')).toBe('fuck');
  });

  it('leaves token-free text untouched', () => {
    expect(stripEmojiTokens('hello there')).toBe('hello there');
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

  it('ignores ids too long to be a real cosmetic id', () => {
    expect(parseEmojiContent(':emoji:999999999999999999999:')).toEqual([
      { type: 'text', value: ':emoji:999999999999999999999:' },
    ]);
  });
});

describe('parseEmojiIds', () => {
  it('returns each id once', () => {
    expect(parseEmojiIds('a :emoji:3: b :emoji:3: c :emoji:4:')).toEqual([3, 4]);
  });

  it('returns nothing for token-free text', () => {
    expect(parseEmojiIds('nothing here')).toEqual([]);
  });
});

describe('parseEmojiLines', () => {
  const jumboFlags = (content: string) => parseEmojiLines(content).map((l) => l.jumbo);

  it('marks a lone emoji jumbo', () => {
    expect(jumboFlags(':emoji:1:')).toEqual([true]);
  });

  it('keeps emoji inline when mixed with text', () => {
    expect(jumboFlags('hey :emoji:1: how are you')).toEqual([false]);
  });

  it('marks several emoji on one line jumbo', () => {
    expect(jumboFlags(':emoji:1::emoji:2::emoji:3:')).toEqual([true]);
  });

  it('ignores stray whitespace around an emoji-only line', () => {
    expect(jumboFlags('  :emoji:1:  :emoji:2: ')).toEqual([true]);
  });

  it('decides per line, so a lone emoji inside a longer message is still jumbo', () => {
    expect(jumboFlags('look at this\n:emoji:1:\nnice right')).toEqual([false, true, false]);
  });

  it('drops back to inline past the jumbo limit', () => {
    const six = ':emoji:1:'.repeat(EMOJI_JUMBO_LIMIT);
    expect(jumboFlags(six)).toEqual([true]);
    expect(jumboFlags(six + ':emoji:1:')).toEqual([false]);
  });

  it('does not mark a text-only or empty line jumbo', () => {
    expect(jumboFlags('just text')).toEqual([false]);
    expect(jumboFlags('')).toEqual([false]);
    expect(jumboFlags('a\n\nb')).toEqual([false, false, false]);
  });

  it('preserves the parts of each line', () => {
    expect(parseEmojiLines('hi :emoji:4:')[0].parts).toEqual([
      { type: 'text', value: 'hi ' },
      { type: 'emoji', cosmeticId: 4 },
    ]);
  });
});
