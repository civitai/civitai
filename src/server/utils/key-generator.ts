import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

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
  const salt = randomBytes(8).toString('hex'); // Might be a good idea to have an env var as secret for hashing
  const buffer = scryptSync(key, salt, API_KEY_LENGTH) as Buffer;

  return `${buffer.toString('hex')}.${salt}`;
}

export function compareKeys(storedKey: string, suppliedKey: string) {
  const [hashedPassword, salt] = storedKey.split('.');
  const buffer = scryptSync(suppliedKey, salt, API_KEY_LENGTH) as Buffer;

  return timingSafeEqual(Buffer.from(hashedPassword, 'hex'), buffer);
}
