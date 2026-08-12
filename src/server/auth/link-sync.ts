import type { NextApiRequest, NextApiResponse } from 'next';
import { cookieDomainForHost } from '~/server/auth/civ-cookie';

// One-shot marker proving THIS browser started an account link through /api/auth/connect, so /api/auth/linked
// will only run post-link side effects for a link it actually initiated. Without it the endpoint is a plain GET
// with a third-party side effect: any page could fire it in a logged-in visitor's browser and spend our Discord
// rate limit. Not a security boundary — linking already happened at the hub — just a cost one.
export const LINK_SYNC_COOKIE = 'civ-link-sync';
const MAX_AGE = 15 * 60;

// Same round trip as the OAuth bridge cookie (spoke → hub → spoke), so it needs the same two properties that
// prod telemetry forced there: SameSite=None to ride a cross-registrable-domain return (civitai.red → the hub
// is cross-site; Lax would drop it), and Domain=<registrable> to survive a www↔apex host variation between the
// set and the read. Lax + host-only in dev, where None-without-Secure is browser-rejected.
function build(value: string, maxAge: number, req: NextApiRequest) {
  const secure = (req.headers?.['x-forwarded-proto'] ?? '').toString().split(',')[0] === 'https';
  const domain = secure ? cookieDomainForHost(req.headers?.host) : undefined;

  return [
    `${LINK_SYNC_COOKIE}=${value}`,
    'Path=/api/auth/linked',
    'HttpOnly',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    ...(domain ? [`Domain=${domain}`] : []),
    `Max-Age=${maxAge}`,
  ].join('; ');
}

function appendCookie(res: NextApiResponse, cookie: string) {
  const existing = res.getHeader('Set-Cookie');
  const cookies = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  res.setHeader('Set-Cookie', [...cookies, cookie]);
}

export function setLinkSyncCookie(req: NextApiRequest, res: NextApiResponse, value: string) {
  appendCookie(res, build(value, MAX_AGE, req));
}

// Reading it consumes it: the expiry header goes out with the redirect, so a replay of the same URL finds no
// cookie and skips the side effect. Cleared with the same attributes it was set with — a Domain-scoped cookie
// can only be cleared by a matching Domain.
export function takeLinkSyncCookie(req: NextApiRequest, res: NextApiResponse) {
  const value = req.cookies?.[LINK_SYNC_COOKIE];
  if (!value) return false;

  appendCookie(res, build('', 0, req));
  return true;
}
