import { createHash, randomBytes } from 'crypto';
import { env } from '~/env/server.mjs';

/**
 * Generates a random public key. Can be send to user.
 */
export function generateKey(length = 32) {
  return randomBytes(length / 2).toString('hex');
}

/**
 * Generates a secret hash based on a public key. Should be stored in the db.
 */
export function generateSecretHash(key: string) {
  return createHash('sha512').update(`${key}${env.NEXTAUTH_SECRET}`).digest('hex');
}
