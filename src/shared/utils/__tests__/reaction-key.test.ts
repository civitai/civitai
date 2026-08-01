import { describe, it, expect } from 'vitest';
import {
  formatEmojiReactionKey,
  isEmojiReactionKey,
  parseReactionKey,
} from '~/shared/utils/reaction-key';

describe('formatEmojiReactionKey', () => {
  it('namespaces the cosmetic id', () => {
    expect(formatEmojiReactionKey(1234)).toBe('emoji:1234');
  });

  it('round-trips through parseReactionKey', () => {
    expect(parseReactionKey(formatEmojiReactionKey(7))).toEqual({ kind: 'emoji', cosmeticId: 7 });
  });
});

describe('isEmojiReactionKey', () => {
  it('is true only for the emoji namespace', () => {
    expect(isEmojiReactionKey('emoji:1')).toBe(true);
    expect(isEmojiReactionKey('Like')).toBe(false);
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

  it('rejects malformed emoji keys', () => {
    expect(parseReactionKey('emoji:')).toBeNull();
    expect(parseReactionKey('emoji:abc')).toBeNull();
    expect(parseReactionKey('emoji:-1')).toBeNull();
    expect(parseReactionKey('emoji:1.5')).toBeNull();
    expect(parseReactionKey('emoji:0')).toBeNull();
  });
});
