import { describe, expect, it } from 'vitest';
import {
  normalizeViewerIp,
  signedInViewerKey,
  signedOutViewerKey,
} from '../block-event-viewer-key';

// Every expected key below was computed OUTSIDE this codebase (python hashlib: the first 8 bytes
// of sha256, big-endian), so the table pins the derivation rather than restating it. The first
// vector is the one the table's migration header and its SQL equivalent were checked against.
describe('viewer keys', () => {
  it.each([
    [42, '6590179527920541835'],
    [9102, '988994381281639022'],
    [7301, '7552154172047254112'],
  ])('signed-in user %i -> %s', (userId, expected) => {
    expect(signedInViewerKey(userId)).toBe(expected);
  });

  it.each([
    ['salt-A', '203.0.113.7', '830607531308821364'],
    // Above 2^63: a signed read of the same bytes would be negative.
    ['salt-A', '2001:db8::1', '13312981865497890023'],
    ['salt-B', '203.0.113.7', '6720762144893895305'],
  ])('signed-out salt %s ip %s -> %s', (salt, ip, expected) => {
    expect(signedOutViewerKey(salt, ip)).toBe(expected);
  });

  it('is a decimal string even where a JS number could not hold the value', () => {
    const key = signedOutViewerKey('salt-A', '2001:db8::1');
    expect(typeof key).toBe('string');
    expect(key).toMatch(/^[0-9]+$/);
    expect(BigInt(key) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    // The corruption the string form exists to avoid: the nearest double is a different integer.
    expect(BigInt(Number(key)).toString()).not.toBe(key);
  });
});

describe('normalizeViewerIp', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['  203.0.113.7 ', '203.0.113.7'],
    // IPv4-mapped IPv6, in each spelling, is the IPv4 address.
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:203.0.113.7', '203.0.113.7'],
    ['::ffff:cb00:7107', '203.0.113.7'],
    ['0:0:0:0:0:ffff:cb00:7107', '203.0.113.7'],
    // IPv6: lower case, zero-compressed, leading zeros dropped.
    ['2001:DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeViewerIp(input)).toBe(expected);
  });

  it.each([['unknown'], [''], ['not-an-ip'], ['203.0.113.7, 198.51.100.1'], ['fe80::1%eth0']])(
    'refuses %j',
    (input) => {
      expect(normalizeViewerIp(input)).toBeNull();
    }
  );

  it.each([[undefined], [null], [7], [['203.0.113.7']]])('refuses the non-string %j', (input) => {
    expect(normalizeViewerIp(input)).toBeNull();
  });

  it('gives one key to every spelling of one address', () => {
    const spellings = ['203.0.113.7', '::ffff:203.0.113.7', '::FFFF:CB00:7107'];
    const keys = spellings.map((ip) => signedOutViewerKey('salt-A', normalizeViewerIp(ip)!));
    expect(new Set(keys)).toEqual(new Set(['830607531308821364']));
  });
});
