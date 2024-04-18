import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { env } from '~/env/server.mjs';
import { EncryptedDataSchema } from '~/server/schema/civToken.schema';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

const algorithm = 'aes-256-cbc';
const encoding = 'base64';
const key = env.NEXTAUTH_SECRET;
const iv = randomBytes(16);

function encrypt(data: string): EncryptedDataSchema {
  const cipher = createCipheriv(algorithm, Buffer.from(key), iv);
  let encrypted = cipher.update(data);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return {
    iv: iv.toString(encoding),
    data: encrypted.toString(encoding),
    signedAt: new Date().toISOString(),
  };
}

export function civTokenDecrypt(data: EncryptedDataSchema) {
  const iv = Buffer.from(data.iv, encoding);
  const encryptedText = Buffer.from(data.data, encoding);
  const decipher = createDecipheriv(algorithm, Buffer.from(key), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

export default AuthedEndpoint(async function handler(req, res, user) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  try {
    const token = encrypt(user.id.toString());
    return res.status(200).json({ token });
  } catch (error: unknown) {
    return res.status(500).send(error);
  }
});
