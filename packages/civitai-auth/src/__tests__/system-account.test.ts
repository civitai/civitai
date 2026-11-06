import { describe, expect, it } from 'vitest';
import { isSystemAccountMeta, SYSTEM_ACCOUNT_META } from '../system-account';

// A false negative opens a hub session for an API-key-only account, so a marker written by hand
// in the wrong shape must still count.
describe('isSystemAccountMeta', () => {
  it.each([
    ['the canonical marker', SYSTEM_ACCOUNT_META],
    ['a string "true"', { systemAccount: 'true' }],
    ['a number', { systemAccount: 1 }],
    ['meta stored as a JSON string', JSON.stringify(SYSTEM_ACCOUNT_META)],
  ])('treats %s as a system account', (_label, meta) => {
    expect(isSystemAccountMeta(meta)).toBe(true);
  });

  it.each([
    ['no meta', null],
    ['an empty object', {}],
    ['an explicit false', { systemAccount: false }],
    ['an unrelated JSON string', '{"banDetails":{}}'],
    ['a non-JSON string', 'not json'],
  ])('treats %s as an ordinary account', (_label, meta) => {
    expect(isSystemAccountMeta(meta)).toBe(false);
  });
});
