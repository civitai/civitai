import { describe, expect, it } from 'vitest';
import { isConfiguredSecret, matchesConfiguredSecret } from '~/server/utils/configured-secret';

describe('isConfiguredSecret', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace', '   '],
    ['a newline', '\n'],
  ])('treats %s as not configured', (_label, secret) => {
    expect(isConfiguredSecret(secret)).toBe(false);
  });

  it('treats a non-blank value as configured', () => {
    expect(isConfiguredSecret('a-real-secret')).toBe(true);
  });
});

describe('matchesConfiguredSecret', () => {
  it.each([
    ['empty secret, empty token', '', ''],
    ['empty secret, absent token', '', undefined],
    ['unset secret, absent token', undefined, undefined],
    ['whitespace secret, same whitespace token', '   ', '   '],
  ])('refuses %s', (_label, secret, presented) => {
    expect(matchesConfiguredSecret(presented, secret)).toBe(false);
  });

  it('POSITIVE CONTROL: admits the configured secret', () => {
    expect(matchesConfiguredSecret('a-real-secret', 'a-real-secret')).toBe(true);
  });

  it('refuses a wrong token and a repeated parameter', () => {
    expect(matchesConfiguredSecret('wrong', 'a-real-secret')).toBe(false);
    expect(matchesConfiguredSecret(['a-real-secret', 'x'], 'a-real-secret')).toBe(false);
  });

  it('compares untrimmed, so two secrets differing only in padding stay distinct', () => {
    expect(matchesConfiguredSecret('a-real-secret', 'a-real-secret ')).toBe(false);
  });
});
