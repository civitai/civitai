import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { env } from '~/env/server';

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

export function encryptText({ text, key, iv }: { text: string; key: string; iv: string }) {
  // Create a cipher using the key and IV
  const cipher = createCipheriv(
    'aes-256-cbc',
    new Uint8Array(Buffer.from(key, 'hex')),
    new Uint8Array(Buffer.from(iv, 'hex'))
  );

  // Encrypt the text
  let encrypted = cipher.update(text, 'utf-8', 'hex');
  encrypted += cipher.final('hex');

  return encrypted;
}

export function decryptText({ text, key, iv }: { text: string; key: string; iv: string }) {
  // Create a decipher using the key and extracted IV
  const decipher = createDecipheriv(
    'aes-256-cbc',
    new Uint8Array(Buffer.from(key, 'hex')),
    new Uint8Array(Buffer.from(iv, 'hex'))
  );

  // Decrypt the text
  let decrypted = decipher.update(text, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');

  return decrypted;
}
