import { dev } from '$app/environment';
import { emailDomain, isBlockedEmailDomain } from '$lib/server/auth/blocklist';
import { userExistsByEmail } from '$lib/server/auth/users';

export type SignupRefusal = 'invalid' | 'blockedDomain' | 'plusBlocked';

/** Why `email` may not start a new account, or null. Assumes no account has it; `plain` is the parsed plain address or null. */
export async function newAccountRefusal(
  email: string,
  plain: string | null
): Promise<SignupRefusal | null> {
  if (!plain) return 'invalid';
  const domain = emailDomain(plain);
  if (domain && (await isBlockedEmailDomain(domain))) return 'blockedDomain';
  if (!dev && email.includes('+')) return 'plusBlocked';
  return null;
}

/** Like newAccountRefusal, but null when the address already has an account, so tightening a rule never locks out a returning user. */
export async function signupRefusal(
  email: string,
  plain: string | null
): Promise<SignupRefusal | null> {
  const refusal = await newAccountRefusal(email, plain);
  if (!refusal || (await userExistsByEmail(email))) return null;
  return refusal;
}
