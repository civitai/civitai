import { describe, expect, it } from 'vitest';
import { keyHashSlot, rejectCrossSlot } from './crucible-cross-slot';

/**
 * The slot helper the crucible vote tests trust to say what the cache cluster refuses. Pinned to
 * the Redis cluster specification, so a helper hashing the wrong bytes or misreading a tag fails
 * here first.
 */
describe('keyHashSlot', () => {
  it('matches the Redis cluster specification', () => {
    // CRC16-XMODEM("123456789") = 0x31C3 = 12739, the CRC's published check value.
    expect(keyHashSlot('123456789')).toBe(12739);
    expect(keyHashSlot('foo')).toBe(12182);
    expect(keyHashSlot('bar')).toBe(5061);
  });

  it('hashes only the first non-empty hash tag', () => {
    expect(keyHashSlot('{user1000}.following')).toBe(3443);
    expect(keyHashSlot('{user1000}.followers')).toBe(3443);
    expect(keyHashSlot('foo{bar}{zap}')).toBe(5061);
    expect(keyHashSlot('foo{{bar}}zap')).toBe(4015);
    // An empty first tag is no tag: the whole key is hashed.
    expect(keyHashSlot('foo{}{bar}')).toBe(8363);
  });
});

describe('rejectCrossSlot', () => {
  it('refuses keys in two slots and accepts keys sharing a tag', () => {
    expect(() => rejectCrossSlot(['foo', 'bar'])).toThrow('CROSSSLOT');
    expect(() => rejectCrossSlot(['a:{x}:1', 'b:{x}:2'])).not.toThrow();
  });
});
