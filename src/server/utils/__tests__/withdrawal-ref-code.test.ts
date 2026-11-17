import { describe, expect, it } from 'vitest';
import {
  generateWithdrawalRefCode,
  parseRefCodeToWithdrawalId,
} from '~/server/utils/creator-program.utils';

// Tipalti caps a payment refCode at 16 characters; the webhook routes cash events on `CW` and
// scopes the lookup by the userId it parses back out.
describe('generateWithdrawalRefCode', () => {
  it.each([1, 5418, 1234567, 123456789])('fits Tipalti and parses back to userId %i', (userId) => {
    const code = generateWithdrawalRefCode(userId);

    expect(code.length).toBeLessThanOrEqual(16);
    expect(code).toMatch(new RegExp(String.raw`^CW${userId}_[0-9a-z]+$`));
    expect(parseRefCodeToWithdrawalId(code).userId).toBe(userId);
  });

  it('refuses a userId that leaves fewer than 4 random characters', () => {
    expect(() => generateWithdrawalRefCode(1234567890)).toThrow('too little room');
  });
});
