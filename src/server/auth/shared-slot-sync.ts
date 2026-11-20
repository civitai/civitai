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
import { createHash } from 'node:crypto';
import { safeInternalPath } from '~/utils/url-helpers';

const SYNC_MARKER = 'civ_slot_sync';
const SYNC_MARKER_TTL_S = 600;
const syncMarkerValue = (token: string) =>
  createHash('sha256').update(token).digest('base64url').slice(0, 22);

/**
 * In host mode, a page navigation that carries the session only in the shared slot is sent through the normal
 * sync (`/api/auth/authorize`), which lands a host-only cookie. Other requests are served from the shared
 * token, unrolled. Null in shared mode, and for anything that is not a top-level GET navigation.
 *
 * A host-only site never reads the shared slot, so it syncs on the cookie's presence alone, and the redirect
 * expires the shared-slot cookies (host-only and on the registrable domain): the sync runs once per cookie, even
 * when the hub has no session to send back.
 *
 * Any other site syncs only a shared cookie that resolved a session (`signedIn`; a dead one browses signed out, as the
 * hub could not verify it either), and once per cookie value: the redirect sets a short-lived marker holding the
 * cookie's hash, so a token the hub refuses is not sent through the sync on every navigation.
 */
export function sharedSlotNavigationSyncUrl(req: {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  cookies?: Partial<Record<string, string>>;
  signedIn: boolean;
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
  } else {
    const read = readSessionToken(req.cookies, { host });
    if (!req.signedIn || read?.slot !== 'shared') return null;
    const marker = syncMarkerValue(read.value);
    if (req.cookies?.[SYNC_MARKER] === marker) return null;
    const secure = isSecureCookie() ? '; Secure' : '';
    setCookies = [
      `${SYNC_MARKER}=${marker}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SYNC_MARKER_TTL_S}${secure}`,
    ];
  }
  const returnUrl = safeInternalPath(req.url, '/');
  return {
    location: `${SPOKE_AUTHORIZE_PATH}?returnUrl=${encodeURIComponent(returnUrl)}`,
    setCookies,
  };
}
