import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

const algorithm = 'aes-256-ctr';
const secretKey = process.env.COOKIE_SECRET_KEY || 'default_secret_key';
const iv = randomBytes(16);

const getKey = (secret: string) => scryptSync(secret, 'salt', 32);

const encrypt = (text: string): string => {
  const cipher = createCipheriv(algorithm, getKey(secretKey), iv);
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
};

const decrypt = (hash: string): string => {
  const [ivHex, encryptedText] = hash.split(':');
  const decipher = createDecipheriv(algorithm, getKey(secretKey), Buffer.from(ivHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString();
};

type Context = {
  req: NextApiRequest;
  res: NextApiResponse;
};

type SetCookieOptions = {
  name: string;
  value: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  path?: string;
};

export const setEncryptedCookie = (ctx: Context, options: SetCookieOptions): void => {
  const {
    name,
    value,
    maxAge = 3600,
    httpOnly = true,
    secure = process.env.NODE_ENV === 'production',
    path = '/',
  } = options;
  const encryptedValue = encrypt(value);
  const cookie = `${name}=${encryptedValue}; Max-Age=${maxAge}; Path=${path}; ${
    httpOnly ? 'HttpOnly;' : ''
  } ${secure ? 'Secure;' : ''}`;

  ctx.res.setHeader('Set-Cookie', cookie);
};

export const deleteEncryptedCookie = (
  ctx: Context,
  options: { name: string; secure?: boolean; path?: string; httpOnly?: boolean }
) => {
  const {
    name,
    secure = process.env.NODE_ENV === 'production',
    path = '/',
    httpOnly = true,
  } = options;
  const cookie = `${name}=''; Max-Age=0; Path=${path}; ${httpOnly ? 'HttpOnly;' : ''} ${
    secure ? 'Secure;' : ''
  }`;
  ctx.res.setHeader('Set-Cookie', cookie);
};

export const getEncryptedCookie = (ctx: Context, name: string): string | null => {
  const cookies = ctx.req.headers.cookie;
  if (!cookies) return null;

  const cookie = cookies.split(';').find((c) => c.trim().startsWith(`${name}=`));
  if (!cookie) return null;

  const encryptedValue = cookie.split('=')[1];
  try {
    return decrypt(encryptedValue);
  } catch (error) {
    console.error('Failed to decrypt cookie:', error);
    return null;
  }
};
