import type { IncomingMessage, ServerResponse } from 'http';
import type { NextApiResponse } from 'next';
import { civTokenDecrypt, civTokenEncrypt } from '~/server/auth/civ-token';
import type { EncryptedDataSchema } from '~/server/schema/civToken.schema';

const COOKIE_NAME = 'civ-og-mod';
const MAX_AGE_SECONDS = 60 * 60 * 12; // 12 hours; re-set on every impersonation start
const COOKIE_PATH = '/';

function cookieFlags() {
  const secure = process.env.NODE_ENV === 'production';
  return `HttpOnly; Path=${COOKIE_PATH}; SameSite=Lax;${secure ? ' Secure;' : ''}`;
}

// Append to any existing Set-Cookie headers rather than replacing them — other
// layers (NextAuth session refresh, etc.) may already have queued Set-Cookies
// on the same response.
function appendSetCookie(res: NextApiResponse | ServerResponse, cookie: string) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
    return;
  }
  const list = Array.isArray(existing) ? existing.map(String) : [String(existing)];
  list.push(cookie);
  res.setHeader('Set-Cookie', list);
}

export function setOgModCookie(res: NextApiResponse | ServerResponse, userId: number) {
  const token = civTokenEncrypt(String(userId));
  // Base64 the JSON so Set-Cookie parsing stays unambiguous.
  const value = Buffer.from(JSON.stringify(token), 'utf8').toString('base64');
  appendSetCookie(res, `${COOKIE_NAME}=${value}; Max-Age=${MAX_AGE_SECONDS}; ${cookieFlags()}`);
}

export function clearOgModCookie(res: NextApiResponse | ServerResponse) {
  appendSetCookie(res, `${COOKIE_NAME}=; Max-Age=0; ${cookieFlags()}`);
}

export function readOgModCookie(req: IncomingMessage): number | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const parts = header.split(';').map((c) => c.trim());
  const match = parts.find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  const raw = match.slice(COOKIE_NAME.length + 1);
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, 'base64').toString('utf8');
    const token = JSON.parse(json) as EncryptedDataSchema;
    const decoded = civTokenDecrypt(token);
    const userId = Number(decoded);
    return Number.isInteger(userId) && userId > 0 ? userId : null;
  } catch {
    return null;
  }
}
