import { describe, expect, test } from 'vitest';
import { generateReferralCode } from '~/server/utils/referral-code';

describe('generateReferralCode', () => {
  test('prefixes the code with the first three letters of the username', () => {
    expect(generateReferralCode('alice')).toMatch(/^ALI-[A-Z]{3}$/);
  });

  test.each([null, undefined, '', 'ab'])('uses random letters for a short username (%s)', (u) => {
    expect(generateReferralCode(u)).toMatch(/^[A-Z]{3}-[A-Z]{3}$/);
  });
});
