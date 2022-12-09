import { createHash, randomBytes } from 'crypto';
import { env } from '~/env/server.mjs';

const API_KEY_LENGTH = 64 as const;

/**
 * Taken from https://shahid.pro/blog/2021/09/22/how-to-generate-api-key-and-secret-to-protect-api/
 */

/**
 * Generates a random public key. Can be send to user.
 */
export function generateKey(size = API_KEY_LENGTH / 2, format: BufferEncoding = 'base64') {
  const buffer = randomBytes(size);
  return buffer.toString(format);
}

/**
 * Generates a secret hash based on a public key. Should be stored in the db.
 */
export function generateSecretHash(key: string) {
  return createHash('sha512').update(`${key}${env.NEXTAUTH_SECRET}`).digest('hex');
}
