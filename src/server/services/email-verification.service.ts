import { randomBytes } from 'crypto';
import { dbRead, dbWrite } from '~/server/db/client';
import { env } from '~/env/server';
import { emailVerificationEmail } from '~/server/email/templates/emailVerification.email';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { refreshSession } from '~/server/auth/session-invalidation';
import { userUpdateCounter } from '~/server/prom/client';

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

  // Invalidate the user's session to ensure they re-authenticate after email change
  await refreshSession(userId);

  return { success: true, message: 'Verification email sent' };
}

export async function confirmEmailChange(token: string) {
  const { userId, newEmail } = await verifyEmailChangeToken(token);

  // Update the user's email
  await dbWrite.user.update({
    where: { id: userId },
    data: { email: newEmail },
  });

  userUpdateCounter?.inc({ location: 'email-verification.service:confirmEmailChange' });

  // Invalidate the user's session after successful email change
  await refreshSession(userId);

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
