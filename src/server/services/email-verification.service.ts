import { randomBytes } from 'crypto';
import { dbRead, dbWrite } from '~/server/db/client';
import { env } from '~/env/server';
import { emailVerificationEmail } from '~/server/email/templates/emailVerification.email';
import {
  handleLogError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { refreshSession } from '~/server/auth/session-invalidation';
import { userUpdateCounter } from '~/server/prom/client';
import { assertEmailAllowed } from '~/server/services/blocklist.service';

const EMAIL_VERIFICATION_EXPIRY = 15 * 60; // 15 minutes in seconds

export async function generateEmailVerificationToken(userId: number, newEmail: string) {
  const token = randomBytes(32).toString('hex');

  // Store the verification data in Redis with expiry
  await redis.set(
    `${REDIS_KEYS.EMAIL_VERIFICATION}:${token}`,
    JSON.stringify({
      userId,
      newEmail,
      createdAt: new Date().toISOString(),
    }),
    {
      EX: EMAIL_VERIFICATION_EXPIRY, // 15 minutes
    }
  );

  return token;
}

export async function validateEmailChangeToken(token: string) {
  const data = await redis.get(`${REDIS_KEYS.EMAIL_VERIFICATION}:${token}`);

  if (!data) {
    throw throwBadRequestError('Invalid or expired verification token');
  }

  const verificationData = JSON.parse(data);

  // Get the current email address for display
  const user = await dbRead.user.findUnique({
    where: { id: verificationData.userId },
    select: { email: true },
  });

  if (!user) {
    throw throwNotFoundError('User not found');
  }

  return {
    ...verificationData,
    currentEmail: user.email,
  } as {
    userId: number;
    newEmail: string;
    currentEmail: string;
    createdAt: string;
  };
}

export async function verifyEmailChangeToken(token: string) {
  const data = await redis.get(`${REDIS_KEYS.EMAIL_VERIFICATION}:${token}`);

  if (!data) {
    throw throwBadRequestError('Invalid or expired verification token');
  }

  const verificationData = JSON.parse(data);

  // Delete the token after successful verification
  await redis.del(`${REDIS_KEYS.EMAIL_VERIFICATION}:${token}`);

  return verificationData as {
    userId: number;
    newEmail: string;
    createdAt: string;
  };
}

export async function requestEmailChange(userId: number, newEmail: string) {
  await assertEmailAllowed(newEmail);

  // Check if the new email is already in use
  const existingUser = await dbRead.user.findFirst({
    where: { email: newEmail },
    select: { id: true },
  });

  if (existingUser && existingUser.id !== userId) {
    throw throwBadRequestError('This email address is already in use by another account');
  }

  // Get current user data
  const user = await dbRead.user.findUnique({
    where: { id: userId },
    select: { email: true, username: true },
  });

  if (!user) {
    throw throwNotFoundError('User not found');
  }

  if (user.email === newEmail) {
    throw throwBadRequestError('This is already your current email address');
  }

  // Generate verification token
  const token = await generateEmailVerificationToken(userId, newEmail);

  // Send verification email
  await sendVerificationEmail(newEmail, user.username || 'User', token);

  // Refresh the cached session shape. 🔴 This does NOT log the user out or force a re-authentication
  // — `refreshSession` marks the user's tokens `refresh` and busts the shaped session-user entry;
  // only `invalidateSession` marks them `invalid`. (The comment here used to claim re-authentication,
  // which would make the `.catch` below read as downgrading a security control. There is no such
  // control on this path, and nothing on the user row has changed yet at this point.)
  //
  // Best-effort: the verification email has already been SENT and the token issued, so a failed
  // cache bust must not 500 this call — the user would see "failed", re-request, and receive a
  // second email for work that already succeeded. Logged rather than swallowed.
  await refreshSession(userId, { caller: 'email-verification' }).catch(handleLogError);

  return { success: true, message: 'Verification email sent' };
}

/**
 * Mint a token for `email` and send it. For a caller that already knows the address — the onboarding
 * step, which has just written it — and so must not re-read a replica that may still hold the old row.
 *
 * 🔴 Deliberately NOT `assertEmailAllowed`, unlike `requestEmailChange`. Every writer of `User.email`
 * already judged this address (#4432); re-judging it against a list that has moved since would leave
 * the account unable to verify and therefore unable to ever post, with no way out. Same reasoning as
 * the unchanged-address case in the onboarding step — see `email-domain-guard.call-sites.test.ts`.
 */
export async function issueEmailVerification(
  userId: number,
  email: string,
  username: string | null
) {
  const token = await generateEmailVerificationToken(userId, email);
  await sendVerificationEmail(email, username || 'User', token);

  return { success: true, message: 'Verification email sent' };
}

/**
 * Send a verification link for the address the account ALREADY has.
 *
 * `requestEmailChange` refuses when the new address equals the current one, so it cannot serve the
 * account that has to prove an address it never changed — which, since `emailVerificationRequired`
 * gates on exactly that, is every account the gate catches.
 */
export async function sendEmailVerification(userId: number) {
  const user = await dbRead.user.findUnique({
    where: { id: userId },
    select: { email: true, username: true, emailVerified: true },
  });

  if (!user) throw throwNotFoundError('User not found');
  if (!user.email) throw throwBadRequestError('Your account has no email address to verify');
  if (user.emailVerified) throw throwBadRequestError('Your email address is already verified');

  return issueEmailVerification(userId, user.email, user.username);
}

export async function confirmEmailChange(token: string) {
  const { userId, newEmail } = await verifyEmailChangeToken(token);

  // Clicking the token link sent to newEmail proves inbox ownership, so mark the email verified — not just
  // set it. emailVerified (not email) is what gates the last-login-method delete guard and hub magic-link
  // login, so leaving it null traps users who can't otherwise self-serve a verified email (ClickUp 868k9gug8).
  await dbWrite.user.update({
    where: { id: userId },
    data: { email: newEmail, emailVerified: new Date() },
  });

  userUpdateCounter?.inc({ location: 'email-verification.service:confirmEmailChange' });

  // Refresh the cached session shape so the new email is served rather than the old one. As above,
  // this is a REFRESH, not a logout — see the note in `requestEmailChange`.
  // 🔴 Best-effort is load-bearing here: the email column is already written AND the one-time token
  // has been consumed, so a throw would report a permanent failure for a change that succeeded and
  // that the user can no longer retry (the link is spent). Staleness is bounded by the session
  // entry's own TTL; a misreported, unretryable write is not.
  await refreshSession(userId, { caller: 'email-verification' }).catch(handleLogError);

  return { success: true, message: 'Email address updated successfully' };
}

async function sendVerificationEmail(email: string, username: string, token: string) {
  const verificationUrl = `${env.NEXTAUTH_URL}/verify-email?token=${token}`;

  await emailVerificationEmail.send({
    to: email,
    username,
    verificationUrl,
  });
}
