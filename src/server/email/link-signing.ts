import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '~/env/server';

// With an empty or short key anyone could compute the links, so no key means no links: every send
// fails closed and every unsubscribe link is refused.
const MIN_KEY_LENGTH = 8;
/**
 * The signature on a link in a notification email. `message` must start with a purpose prefix of
 * its own, so a signature minted for one kind of link never verifies as another.
 */
export const signEmailLink = (message: string) => {
  if ((env.NEXTAUTH_SECRET?.length ?? 0) < MIN_KEY_LENGTH)
    throw new Error('No server secret to sign email links with');
  return createHmac('sha256', env.NEXTAUTH_SECRET).update(message).digest('hex').slice(0, 32);
};

/** Whether `sig` is `message`'s signature. False, never a throw, when there is no key. */
export function verifyEmailLinkSignature(message: string, sig: string) {
  try {
    const expected = Buffer.from(signEmailLink(message));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  } catch {
    return false;
  }
}
