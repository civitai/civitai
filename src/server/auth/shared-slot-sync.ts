import { readSessionToken, sessionCookieMode, SPOKE_AUTHORIZE_PATH } from '@civitai/auth/client';
import { safeInternalPath } from '~/utils/url-helpers';

/**
 * In host mode, a page navigation that carries the session only in the shared slot is sent through the normal
 * sync (`/api/auth/authorize`), which lands a host-only cookie. Other requests are served from the shared
 * token, unrolled. Null in shared mode, and for anything that is not a top-level GET navigation.
 */
export function sharedSlotNavigationSyncUrl(req: {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  cookies?: Partial<Record<string, string>>;
}): string | null {
  if (sessionCookieMode() !== 'host') return null;
  if ((req.method ?? 'GET') !== 'GET' || req.headers['sec-fetch-mode'] !== 'navigate') return null;
  if (readSessionToken(req.cookies)?.slot !== 'shared') return null;
  const returnUrl = safeInternalPath(req.url, '/');
  return `${SPOKE_AUTHORIZE_PATH}?returnUrl=${encodeURIComponent(returnUrl)}`;
}
