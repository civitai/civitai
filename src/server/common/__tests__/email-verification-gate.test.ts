import { describe, expect, it } from 'vitest';
import { requiresEmailVerification } from '~/server/common/email-verification-gate';

describe('requiresEmailVerification', () => {
  /**
   * 🔴 DO NOT relax this into "unverified ⇒ gated". It is the decision the design turns on, not an
   * incidental case. 7,156,750 live accounts have `emailVerified IS NULL` and 409,832 of them have
   * posted; the column was only ever populated by magic-link and verified OAuth, so a null on an old
   * account means "we never asked", not "they refused". Reading `emailVerified` alone — or comparing
   * `createdAt` against a cutover date someone has to keep correct — silences that population the
   * moment the comparison is wrong. The stamp is what makes that impossible.
   */
  it('leaves a legacy unverified account alone — only the onboarding stamp gates', () => {
    expect(requiresEmailVerification({ emailVerified: null, meta: {} })).toBe(false);
    expect(requiresEmailVerification({ emailVerified: null })).toBe(false);
    expect(requiresEmailVerification({ emailVerified: null, meta: { muteReason: 'x' } })).toBe(
      false
    );
  });

  it('gates a stamped account with no verified address', () => {
    expect(
      requiresEmailVerification({ emailVerified: null, meta: { emailVerificationRequired: true } })
    ).toBe(true);
  });

  it('releases the moment the address is verified, without clearing the stamp', () => {
    expect(
      requiresEmailVerification({
        emailVerified: new Date('2026-08-27T00:00:00Z'),
        meta: { emailVerificationRequired: true },
      })
    ).toBe(false);
    // `emailVerified` arrives off a JSON session as a string on some paths.
    expect(
      requiresEmailVerification({
        emailVerified: '2026-08-27T00:00:00Z',
        meta: { emailVerificationRequired: true },
      })
    ).toBe(false);
  });

  it('requires the literal boolean — a truthy lookalike does not gate', () => {
    for (const value of ['true', 1, {}, [], 'yes']) {
      expect(
        requiresEmailVerification({
          emailVerified: null,
          meta: { emailVerificationRequired: value },
        })
      ).toBe(false);
    }
    expect(
      requiresEmailVerification({ emailVerified: null, meta: { emailVerificationRequired: false } })
    ).toBe(false);
  });

  it('survives a meta that is not an object', () => {
    for (const meta of [null, undefined, 'string', 42, ['emailVerificationRequired']]) {
      expect(requiresEmailVerification({ emailVerified: null, meta })).toBe(false);
    }
  });

  it('returns false for no user rather than throwing', () => {
    expect(requiresEmailVerification(null)).toBe(false);
    expect(requiresEmailVerification(undefined)).toBe(false);
  });
});
