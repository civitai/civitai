import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_VIEWER_KEY,
  rateLimitAddressKey,
  signedInViewerKey,
} from '../block-event-viewer-key';

// Every expected key below was computed OUTSIDE this codebase (python hashlib: the first 8 bytes
// of sha256, big-endian), so the table pins the derivation rather than restating it.
describe('viewer keys', () => {
  it.each([
    [42, '6590179527920541835'],
    [9102, '988994381281639022'],
    [7301, '7552154172047254112'],
  ])('signed-in user %i -> %s', (userId, expected) => {
    expect(signedInViewerKey(userId)).toBe(expected);
  });

  it('is a decimal string even where a JS number could not hold the value', () => {
    const key = signedInViewerKey(42);
    expect(typeof key).toBe('string');
    expect(BigInt(key) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    // The corruption the string form exists to avoid: the nearest double is a different integer.
    expect(BigInt(Number(key)).toString()).not.toBe(key);
  });

  it('a signed-out viewer is the unknown-viewer key 0, which no signed-in key can equal', () => {
    expect(ANONYMOUS_VIEWER_KEY).toBe('0');
    for (const userId of [0, 1, 42, 9102]) expect(signedInViewerKey(userId)).not.toBe('0');
  });
});

describe('rateLimitAddressKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['2001:db8:aa:bb::1', '2001:db8:aa:bb::/64'],
    ['2001:db8:aa:bb:1234:5678:9abc:def0', '2001:db8:aa:bb::/64'],
    // Zero groups inside the prefix are restored before it is cut.
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['2001:db8::7:0:0:0:1', '2001:db8:0:7::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::', 'fe80:0:0:0::/64'],
  ])('%s -> %s', (ip, expected) => {
    expect(rateLimitAddressKey(ip)).toBe(expected);
  });

  it('separates neighbouring /64s', () => {
    expect(rateLimitAddressKey('2001:db8:aa:bb::1')).not.toBe(
      rateLimitAddressKey('2001:db8:aa:bc::1')
    );
  });
});
