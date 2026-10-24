import { describe, expect, it } from 'vitest';
import { rankStickerMatch, stickerQueryAtCaret } from '~/shared/utils/sticker-token';

/**
 * What counts as "typing a sticker" in the composer.
 *
 * The cost of being wrong runs one way: a false positive pops a list over a
 * message someone is writing, on a character (`:`) that appears in ordinary
 * text far more often than it starts a sticker.
 */
describe('stickerQueryAtCaret', () => {
  const at = (text: string) => stickerQueryAtCaret(text, text.length);

  it('reads the partial slug being typed', () => {
    expect(at(':fi')).toEqual({ query: 'fi', start: 0 });
    expect(at('hey :fi')).toEqual({ query: 'fi', start: 4 });
  });

  it('reports where to splice, not just what was typed', () => {
    // The caller replaces from `start`, so an off-by-one here eats the
    // character before the colon or leaves the colon behind.
    const found = at('nice work :fi');
    expect(found).not.toBeNull();
    expect('nice work :fi'.slice(found!.start)).toBe(':fi');
  });

  it('stops at a completed token', () => {
    // `:fire:` is finished. Continuing to suggest would reopen the list on
    // every keystroke after it.
    expect(at(':fire:')).toBeNull();
    expect(at(':fire: ')).toBeNull();
  });

  it('ignores a colon that is not opening a token', () => {
    expect(at('https://example.com/a')).toBeNull();
    expect(at('meet at 12:30')).toBeNull();
    expect(at('ratio 3:2')).toBeNull();
    // A bare colon is not yet a query — every sticker would match.
    expect(at('so:')).toBeNull();
    expect(at(':')).toBeNull();
  });

  it('reads the token under the caret, not the last one in the message', () => {
    const text = ':fi and :he';
    // Caret parked right after `:fi`, with more text to its right.
    expect(stickerQueryAtCaret(text, 3)).toEqual({ query: 'fi', start: 0 });
  });

  it('matches case-insensitively but answers in slug case', () => {
    expect(at(':FI')).toEqual({ query: 'fi', start: 0 });
  });
});

/**
 * Ordering, not just filtering. A typeahead shows a handful of rows, so the
 * obvious answer has to be among them — `fi` must offer `fire` before a
 * sticker that merely contains "fi" in its name.
 */
describe('rankStickerMatch', () => {
  it('ranks a prefix above a substring above a keyword', () => {
    const prefix = rankStickerMatch('fi', 'fire', 'flame');
    const substring = rankStickerMatch('fi', 'campfire', 'outdoors');
    const keyword = rankStickerMatch('fi', 'flame', 'fire hot');

    expect(prefix).not.toBeNull();
    expect(substring).not.toBeNull();
    expect(keyword).not.toBeNull();
    expect(prefix!).toBeLessThan(substring!);
    expect(substring!).toBeLessThan(keyword!);
  });

  it('rejects what matches nowhere', () => {
    expect(rankStickerMatch('zzz', 'fire', 'flame hot')).toBeNull();
  });

  it('does not need the extra text to exist', () => {
    expect(rankStickerMatch('fi', 'fire')).toBe(0);
    expect(rankStickerMatch('hot', 'fire')).toBeNull();
  });
});
