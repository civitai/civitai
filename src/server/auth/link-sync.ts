import type { NextApiRequest, NextApiResponse } from 'next';

// One-shot marker proving THIS browser started an account link through /api/auth/connect, so /api/auth/linked
// will only run post-link side effects for a link it actually initiated. Without it the endpoint is a plain GET
// with a third-party side effect: any page could fire it in a logged-in visitor's browser and spend our Discord
// rate limit. Not a security boundary — linking already happened at the hub — just a cost one.
export const LINK_SYNC_COOKIE = 'civ-link-sync';
const MAX_AGE = 10 * 60;

function appendCookie(res: NextApiResponse, cookie: string) {
  const existing = res.getHeader('Set-Cookie');
  const cookies = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  res.setHeader('Set-Cookie', [...cookies, cookie]);
}

function attributes() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `Path=/api/auth/linked; HttpOnly; SameSite=Lax${secure}`;
}

export function setLinkSyncCookie(res: NextApiResponse, value: string) {
  appendCookie(res, `${LINK_SYNC_COOKIE}=${value}; Max-Age=${MAX_AGE}; ${attributes()}`);
}

// Reading it consumes it: the expiry header goes out with the redirect, so a replay of the same URL finds no
// cookie and skips the side effect.
export function takeLinkSyncCookie(req: NextApiRequest, res: NextApiResponse) {
  const value = req.cookies?.[LINK_SYNC_COOKIE];
  if (!value) return false;

  appendCookie(res, `${LINK_SYNC_COOKIE}=; Max-Age=0; ${attributes()}`);
  return true;
}
