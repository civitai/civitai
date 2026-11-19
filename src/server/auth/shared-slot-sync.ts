import {
  hostOnlySite,
  isSecureCookie,
  otherSlotExpiries,
  readSessionToken,
  registrableDomain,
  sessionCookieMode,
  sessionCookieNameForSlot,
  SPOKE_AUTHORIZE_PATH,
} from '@civitai/auth/client';
import { safeInternalPath } from '~/utils/url-helpers';

/**
 * In host mode, a page navigation that carries the session only in the shared slot is sent through the normal
 * sync (`/api/auth/authorize`), which lands a host-only cookie. Other requests are served from the shared
 * token, unrolled. Null in shared mode, and for anything that is not a top-level GET navigation.
 *
 * A host-only site never reads the shared slot, so it syncs on the cookie's presence alone, and the redirect
 * expires the shared-slot cookies (host-only and on the registrable domain): the sync runs once per cookie, even
 * when the hub has no session to send back.
 */
export function sharedSlotNavigationSyncUrl(req: {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  cookies?: Partial<Record<string, string>>;
}): { location: string; setCookies: string[] } | null {
  const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
  if (sessionCookieMode(host) !== 'host') return null;
  if ((req.method ?? 'GET') !== 'GET' || req.headers['sec-fetch-mode'] !== 'navigate') return null;
  let setCookies: string[] = [];
  if (hostOnlySite(host)) {
    const secure = isSecureCookie();
    const shared = sessionCookieNameForSlot('shared', secure);
    const own = sessionCookieNameForSlot('host', secure);
    if (shared === own || !req.cookies?.[shared] || req.cookies[own]) return null;
    const domain = registrableDomain((host ?? '').split(':')[0]);
    setCookies = otherSlotExpiries('host', req.cookies, secure, domain);
  } else if (readSessionToken(req.cookies, { host })?.slot !== 'shared') return null;
  const returnUrl = safeInternalPath(req.url, '/');
  return {
    location: `${SPOKE_AUTHORIZE_PATH}?returnUrl=${encodeURIComponent(returnUrl)}`,
    setCookies,
  };
}
