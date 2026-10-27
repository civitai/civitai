import { DEVICE_COOKIE_BASE, HOST_COOKIE_PREFIX, SESSION_COOKIE_BASE } from './constants';
import {
  allCookieNames,
  parseCookieHeader,
  sessionCookieNameForSlot,
  type CookieSlot,
} from './cookies';
import { hubBaseUrl } from './hub';
import { hubLogoutUrl } from './providers';
import { createSessionTokenClient, type SessionTokenClient } from './session-token-client';

export interface SpokeLogoutOptions {
  /** Where the hub sends the browser once it has signed out. Defaults to the spoke's own origin. */
  returnUrl?: string;
  /** Defaults to `AUTH_JWT_ISSUER`. */
  hubBase?: string | null;
  sessionTokenClient?: Pick<SessionTokenClient, 'revoke'>;
}

// Same 2-label registrable domain the hub and the main app scope the shared cookie to.
export function registrableDomain(hostname: string): string | undefined {
  const h = hostname.toLowerCase();
  if (!h || h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return undefined;
  const parts = h.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : undefined;
}

/** Set-Cookie values that expire this spoke's session and device cookies under every name and scope. */
export function spokeLogoutCookies(hostname: string): string[] {
  const domain = registrableDomain(hostname);
  const out: string[] = [];
  for (const name of [
    ...allCookieNames(SESSION_COOKIE_BASE),
    ...allCookieNames(DEVICE_COOKIE_BASE),
  ]) {
    const secure = name.startsWith('__');
    const base = `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
    out.push(base);
    if (domain && !name.startsWith(HOST_COOKIE_PREFIX)) out.push(`${base}; Domain=${domain}`);
  }
  return out;
}

/**
 * A spoke's `/logout`: clear its cookies, revoke its token at the hub, then send the browser through the hub's
 * logout so the hub's own cookies are cleared too. Without a hub configured it just returns to `returnUrl`.
 */
export async function spokeLogout(
  request: Request,
  opts: SpokeLogoutOptions = {}
): Promise<Response> {
  const url = new URL(request.url);
  const returnUrl = opts.returnUrl ?? url.origin;
  const hub = opts.hubBase === undefined ? hubBaseUrl() : opts.hubBase;

  // Both slots, whatever this app's mode: logout expires both cookies, so a token left unrevoked would stay live.
  const cookies = parseCookieHeader(request.headers.get('cookie') ?? '');
  const slots: CookieSlot[] = ['shared', 'host'];
  const tokens = new Set(
    slots.map((slot) => cookies[sessionCookieNameForSlot(slot)]).filter((t): t is string => !!t)
  );
  if (tokens.size) {
    const client = opts.sessionTokenClient ?? createSessionTokenClient();
    for (const token of tokens) await client.revoke(token);
  }

  const headers = new Headers({
    location: hub ? hubLogoutUrl(hub, returnUrl) : returnUrl,
    'cache-control': 'no-store',
  });
  for (const c of spokeLogoutCookies(url.hostname)) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}
