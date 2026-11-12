import { describe, expect, it } from 'vitest';
import { parsePlainEmailAddress, type AddressParser } from '../plain-email';

// Real-parser cases live beside each caller (apps/auth login action, main app assertEmailAllowed),
// where the parser is the one that app delivers with. These stubs pin the comparison on its own.
const echo: AddressParser = (input) => [{ address: input }];

describe('parsePlainEmailAddress', () => {
  it('returns a plain address, trimmed', () => {
    expect(parsePlainEmailAddress('  user@ok.test  ', echo)).toBe('user@ok.test');
  });

  it('accepts a trailing root dot', () => {
    expect(parsePlainEmailAddress('user@ok.test.', echo)).toBe('user@ok.test.');
  });

  it('accepts an internationalised domain in punycode form', () => {
    expect(parsePlainEmailAddress('user@xn--bcher-kva.de', echo)).toBe('user@xn--bcher-kva.de');
  });

  it.each([
    'user@ok.test(x).other.test',
    'user@ok.test .other.test',
    '"user"@ok.test',
    'Name <user@ok.test>',
    'a@ok.test,b@ok.test',
    'a@ok.test;b@ok.test',
    'group:user@ok.test;',
    'user@[127.0.0.1]',
    'us\\er@ok.test',
    'user@b\u00FCcher.de',
    'user@ok.test\u0000x',
    'user@ok\u3002test',
    'a@other.test@ok.test',
    'a@@ok.test',
    '@ok.test',
    'a@',
    'a@.ok.test',
    'a@ok..test',
    '',
  ])('refuses %j before parsing', (input) => {
    expect(parsePlainEmailAddress(input, echo)).toBeNull();
  });

  it('refuses when the parser finds more than one address', () => {
    const two: AddressParser = () => [{ address: 'a@ok.test' }, { address: 'b@ok.test' }];
    expect(parsePlainEmailAddress('a@ok.test', two)).toBeNull();
  });

  it('refuses when the parser finds none', () => {
    expect(parsePlainEmailAddress('a@ok.test', () => [])).toBeNull();
  });

  it('refuses when the parser reads a group', () => {
    const group: AddressParser = () => [{ group: [], address: 'a@ok.test' }];
    expect(parsePlainEmailAddress('a@ok.test', group)).toBeNull();
  });

  it('refuses when the parser would deliver to a different address', () => {
    const rewrites: AddressParser = () => [{ address: 'user@elsewhere.test' }];
    expect(parsePlainEmailAddress('user@ok.test', rewrites)).toBeNull();
  });

  it('accepts a case-only difference and returns the parsed address', () => {
    const lower: AddressParser = (input) => [{ address: input.toLowerCase() }];
    expect(parsePlainEmailAddress('User@OK.test', lower)).toBe('user@ok.test');
  });
});
