import calculateSlot from 'cluster-key-slot';
import { describe, expect, it } from 'vitest';
import { keyHashSlot, keyHashSlots } from '../key-slot';

/**
 * The slot helper other suites use to assert that a MULTI or a script stays in one cluster slot.
 * Pinned to values from the Redis cluster specification, so a helper that hashed the wrong bytes
 * or misread a hash tag fails here before any suite trusts it.
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
    // The first `{` and the next `}`: the tag is `{bar`.
    expect(keyHashSlot('foo{{bar}}zap')).toBe(4015);
    // An empty first tag is no tag: the whole key is hashed.
    expect(keyHashSlot('foo{}{bar}')).toBe(8363);
  });

  it("agrees with node-redis's router on keys with no empty tag", () => {
    const keys = ['dl:link:abc', 'app:review-sheet:session:{x_y-Z}:batches', 'a{b}c', '{}', 'é{ü}'];
    for (const key of keys.filter((k) => !k.includes('{}')))
      expect(keyHashSlot(key)).toBe(calculateSlot(key));
  });

  it('reports one slot for keys sharing a tag and several for untagged ones', () => {
    expect(keyHashSlots(['a:{x}:1', 'b:{x}:2', 'c:{x}'])).toHaveLength(1);
    expect(keyHashSlots(['foo', 'bar'])).toEqual([12182, 5061]);
  });
});
