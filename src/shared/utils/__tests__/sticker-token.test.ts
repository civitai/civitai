import { describe, it, expect } from 'vitest';
import {
  STICKER_JUMBO_LIMIT,
  formatStickerToken,
  isValidStickerSlug,
  parseStickerContent,
  parseStickerIds,
  parseStickerLines,
  resolveStickerTokens,
  stripStickerTokens,
} from '~/shared/utils/sticker-token';

const owned: Record<string, number> = { party_cat: 12, wave: 34 };
const resolveSlug = (slug: string) => owned[slug];
const isOwnedId = (id: number) => Object.values(owned).includes(id);

describe('isValidStickerSlug', () => {
  it('accepts lowercase alphanumeric + underscore, 2-32 chars', () => {
    expect(isValidStickerSlug('party_cat')).toBe(true);
    expect(isValidStickerSlug('a1')).toBe(true);
    expect(isValidStickerSlug('123abc')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isValidStickerSlug('a')).toBe(false);
    expect(isValidStickerSlug('Party')).toBe(false);
    expect(isValidStickerSlug('party-cat')).toBe(false);
    expect(isValidStickerSlug('x'.repeat(33))).toBe(false);
  });

  it('rejects all-digit slugs so clock times are not sticker', () => {
    expect(isValidStickerSlug('30')).toBe(false);
    expect(isValidStickerSlug('1234')).toBe(false);
  });
});

describe('resolveStickerTokens', () => {
  it('rewrites owned slugs to id tokens', () => {
    expect(resolveStickerTokens('hi :party_cat: there', { resolveSlug })).toBe(
      'hi :sticker:12: there'
    );
  });

  it('leaves unowned slugs alone', () => {
    expect(resolveStickerTokens('hi :nope: there', { resolveSlug })).toBe('hi :nope: there');
  });

  it('resolves multiple slugs including repeats', () => {
    expect(resolveStickerTokens(':wave::wave::party_cat:', { resolveSlug })).toBe(
      ':sticker:34::sticker:34::sticker:12:'
    );
  });

  it('leaves clock times untouched', () => {
    expect(resolveStickerTokens('Meeting at 12:30: see you', { resolveSlug })).toBe(
      'Meeting at 12:30: see you'
    );
  });

  it('without an ownership gate, passes raw tokens through for optimistic render', () => {
    expect(resolveStickerTokens('a :sticker:99: b', { resolveSlug })).toBe('a :sticker:99: b');
  });

  it('deletes tokens the sender does not own', () => {
    expect(resolveStickerTokens('a :sticker:99: b', { resolveSlug, isOwnedId })).toBe('a  b');
  });

  it('keeps tokens the sender owns', () => {
    expect(resolveStickerTokens('a :sticker:12: b', { resolveSlug, isOwnedId })).toBe(
      'a :sticker:12: b'
    );
  });

  it('deleting an unowned token rejoins the text so blocklists still match', () => {
    expect(
      stripStickerTokens(resolveStickerTokens('fu:sticker:99:ck', { resolveSlug, isOwnedId }))
    ).toBe('fuck');
  });
});

describe('stripStickerTokens', () => {
  it('rejoins text split by an owned token', () => {
    expect(stripStickerTokens('fu:sticker:12:ck')).toBe('fuck');
  });

  it('leaves token-free text untouched', () => {
    expect(stripStickerTokens('hello there')).toBe('hello there');
  });
});

describe('parseStickerContent', () => {
  it('returns a single text part when there are no tokens', () => {
    expect(parseStickerContent('hello')).toEqual([{ type: 'text', value: 'hello' }]);
  });

  it('splits text around tokens', () => {
    expect(parseStickerContent(`a ${formatStickerToken(5)} b`)).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'sticker', cosmeticId: 5 },
      { type: 'text', value: ' b' },
    ]);
  });

  it('handles adjacent tokens and leading/trailing positions', () => {
    expect(parseStickerContent(':sticker:1::sticker:2:')).toEqual([
      { type: 'sticker', cosmeticId: 1 },
      { type: 'sticker', cosmeticId: 2 },
    ]);
  });

  it('ignores ids too long to be a real cosmetic id', () => {
    expect(parseStickerContent(':sticker:999999999999999999999:')).toEqual([
      { type: 'text', value: ':sticker:999999999999999999999:' },
    ]);
  });
});

describe('parseStickerIds', () => {
  it('returns each id once', () => {
    expect(parseStickerIds('a :sticker:3: b :sticker:3: c :sticker:4:')).toEqual([3, 4]);
  });

  it('returns nothing for token-free text', () => {
    expect(parseStickerIds('nothing here')).toEqual([]);
  });
});

describe('parseStickerLines', () => {
  const jumboFlags = (content: string) => parseStickerLines(content).map((l) => l.jumbo);

  it('marks a lone sticker jumbo', () => {
    expect(jumboFlags(':sticker:1:')).toEqual([true]);
  });

  it('keeps sticker inline when mixed with text', () => {
    expect(jumboFlags('hey :sticker:1: how are you')).toEqual([false]);
  });

  it('marks several sticker on one line jumbo', () => {
    expect(jumboFlags(':sticker:1::sticker:2::sticker:3:')).toEqual([true]);
  });

  it('ignores stray whitespace around an sticker-only line', () => {
    expect(jumboFlags('  :sticker:1:  :sticker:2: ')).toEqual([true]);
  });

  it('decides per line, so a lone sticker inside a longer message is still jumbo', () => {
    expect(jumboFlags('look at this\n:sticker:1:\nnice right')).toEqual([false, true, false]);
  });

  it('drops back to inline past the jumbo limit', () => {
    const six = ':sticker:1:'.repeat(STICKER_JUMBO_LIMIT);
    expect(jumboFlags(six)).toEqual([true]);
    expect(jumboFlags(six + ':sticker:1:')).toEqual([false]);
  });

  it('does not mark a text-only or empty line jumbo', () => {
    expect(jumboFlags('just text')).toEqual([false]);
    expect(jumboFlags('')).toEqual([false]);
    expect(jumboFlags('a\n\nb')).toEqual([false, false, false]);
  });

  it('preserves the parts of each line', () => {
    expect(parseStickerLines('hi :sticker:4:')[0].parts).toEqual([
      { type: 'text', value: 'hi ' },
      { type: 'sticker', cosmeticId: 4 },
    ]);
  });
});

// The token was `:emoji:<id>:` before the sticker rename. Nothing is in prod,
// but dev has sent messages and the stored form must keep rendering.
describe('legacy :emoji: tokens', () => {
  it('parses the old form', () => {
    expect(parseStickerContent('a :emoji:5: b')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'sticker', cosmeticId: 5 },
      { type: 'text', value: ' b' },
    ]);
  });

  it('strips the old form for the content scanners', () => {
    expect(stripStickerTokens('fu:emoji:12:ck')).toBe('fuck');
  });

  it('counts old-form ids when collecting for a fetch', () => {
    expect(parseStickerIds('a :emoji:3: b :sticker:4:')).toEqual([3, 4]);
  });

  it('normalizes an owned legacy token to the current form', () => {
    expect(resolveStickerTokens('a :emoji:12: b', { resolveSlug, isOwnedId })).toBe(
      'a :sticker:12: b'
    );
  });

  it('still deletes an unowned legacy token', () => {
    expect(resolveStickerTokens('a :emoji:99: b', { resolveSlug, isOwnedId })).toBe('a  b');
  });

  it('only ever writes the new form', () => {
    expect(formatStickerToken(5)).toBe(':sticker:5:');
  });
});
