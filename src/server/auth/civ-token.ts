import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { env } from '~/env/server';
import type { EncryptedDataSchema } from '~/server/schema/civToken.schema';

const algorithm = 'aes-256-cbc';
const encoding = 'base64';
const key = env.NEXTAUTH_SECRET;

export function civTokenEncrypt(data: string): EncryptedDataSchema {
  const iv = randomBytes(16);
  const cipher = createCipheriv(algorithm, new Uint8Array(Buffer.from(key)), new Uint8Array(iv));
  let encrypted = cipher.update(data, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return {
    iv: iv.toString(encoding),
    data: encrypted,
    signedAt: new Date().toISOString(),
  };
}

export function civTokenDecrypt(data: EncryptedDataSchema) {
  const iv = Buffer.from(data.iv, encoding);
  const decipher = createDecipheriv(
    algorithm,
    new Uint8Array(Buffer.from(key)),
    new Uint8Array(iv)
  );
  let decrypted = decipher.update(data.data, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
