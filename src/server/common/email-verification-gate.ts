/**
 * Whether this account has to prove its email address before it may create content.
 *
 * 🔴 Gates on a marker written at ONBOARDING, never on `emailVerified` alone. 7,156,750 live accounts
 * have `emailVerified IS NULL` and 409,832 of them have posted — the column was only ever populated by
 * magic-link and verified OAuth, so its absence on an old account means nothing. An opt-in marker only
 * new signups can receive makes silencing them impossible rather than merely unlikely; an account-age
 * comparison against a cutover date does not, because the date has to stay correct.
 *
 * So: absent, false, or any non-`true` value means NOT required. Only the literal stamp gates.
 */
export function requiresEmailVerification(
  user: { emailVerified?: Date | string | null; meta?: unknown } | null | undefined
): boolean {
  if (!user) return false;
  if (user.emailVerified) return false;
  const meta = user.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  return (meta as { emailVerificationRequired?: unknown }).emailVerificationRequired === true;
}
