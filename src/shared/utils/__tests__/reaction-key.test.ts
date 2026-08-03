import { describe, it, expect } from 'vitest';
import {
  formatStickerReactionKey,
  isStickerReactionKey,
  parseReactionKey,
} from '~/shared/utils/reaction-key';

describe('formatStickerReactionKey', () => {
  it('namespaces the cosmetic id', () => {
    expect(formatStickerReactionKey(1234)).toBe('sticker:1234');
  });

  it('round-trips through parseReactionKey', () => {
    expect(parseReactionKey(formatStickerReactionKey(7))).toEqual({
      kind: 'sticker',
      cosmeticId: 7,
    });
  });
});

describe('isStickerReactionKey', () => {
  it('is true only for the sticker namespace', () => {
    expect(isStickerReactionKey('sticker:1')).toBe(true);
    expect(isStickerReactionKey('Like')).toBe(false);
  });
});

describe('parseReactionKey', () => {
  it('parses built-in reactions', () => {
    expect(parseReactionKey('Like')).toEqual({ kind: 'builtin', reaction: 'Like' });
    expect(parseReactionKey('Heart')).toEqual({ kind: 'builtin', reaction: 'Heart' });
  });

  it('rejects unknown built-ins', () => {
    expect(parseReactionKey('Applause')).toBeNull();
    expect(parseReactionKey('like')).toBeNull();
  });

  it('rejects malformed sticker keys', () => {
    expect(parseReactionKey('sticker:')).toBeNull();
    expect(parseReactionKey('sticker:abc')).toBeNull();
    expect(parseReactionKey('sticker:-1')).toBeNull();
    expect(parseReactionKey('sticker:1.5')).toBeNull();
    expect(parseReactionKey('sticker:0')).toBeNull();
  });
});
