import { requiresEmailVerification } from '~/server/common/email-verification-gate';

export const RESTRICTED_ACCOUNT_MESSAGE =
  'You cannot perform this action because your account has been restricted';
export const EMAIL_VERIFICATION_REQUIRED_MESSAGE = 'Verify your email address to do this';

/**
 * Why `guardedProcedure` refuses this account (`isMuted`, then `isEmailVerified`), or undefined,
 * for a write that runs inside a procedure without that guard.
 */
export function contentRestriction(user: {
  muted?: boolean | null;
  emailVerified?: Date | string | null;
  meta?: unknown;
}) {
  if (user.muted) return RESTRICTED_ACCOUNT_MESSAGE;
  if (requiresEmailVerification(user)) return EMAIL_VERIFICATION_REQUIRED_MESSAGE;
  return undefined;
}
