import { createCipheriv, createDecipheriv } from 'crypto';

// generateKey + generateSecretHash moved to @civitai/auth/secret-hash so the hub and the main app derive
// the SAME hash from the same key (shared NEXTAUTH_SECRET salt). Re-exported here so existing call sites
// import from '~/server/utils/key-generator' unchanged. encryptText/decryptText stay — main-app only.
export { generateKey, generateSecretHash } from '@civitai/auth/secret-hash';

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
