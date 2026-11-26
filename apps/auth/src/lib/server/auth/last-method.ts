import type { Cookies } from '@sveltejs/kit';
import { isSecureCookie } from '@civitai/auth';
import { isEmailConfigured } from '@civitai/email';
import { logToAxiom } from '../axiom';
import { listEnabledProviders } from './providers';

/** Remembers which sign-in method this browser last completed (a provider id or `email`), so the login page
 *  can mark it. Holds nothing that identifies the account. Kept across logout. */
const COOKIE_BASE = 'civ_last_method';
const MAX_AGE_S = 34_560_000; // 400 days, the longest a browser keeps a cookie
const METHOD_RE = /^[a-z0-9_-]+$/;

// `__Host-` requires Secure, so on http dev the bare name is used, as for the hub's host-only session cookie.
export const lastMethodCookieName = (secure: boolean = isSecureCookie()): string =>
  `${secure ? '__Host-' : ''}${COOKIE_BASE}`;

/** Call only after the session is established. */
export function rememberLastMethod(cookies: Pick<Cookies, 'set'>, method: string): void {
  if (!METHOD_RE.test(method)) return;
  const secure = isSecureCookie();
  cookies.set(lastMethodCookieName(secure), method, {
    path: '/',
    secure,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: MAX_AGE_S,
  });
}

/** The remembered method, if it is one this hub currently offers; null for anything else. */
export function readLastMethod(cookies: Pick<Cookies, 'get'>): string | null {
  const value = cookies.get(lastMethodCookieName());
  if (!value) return null;
  if (value === 'email') return isEmailConfigured() ? value : null;
  return listEnabledProviders().some((p) => p.id === value) ? value : null;
}

/** Called when a sign-in creates a new account: records when the browser last signed in another way. */
export function logNewAccountMethodSwitch(lastMethod: string | null | undefined, method: string) {
  if (!lastMethod || lastMethod === method) return;
  void logToAxiom({
    type: 'info',
    name: 'new-account-other-last-method',
    payload: { lastMethod, method },
  });
}
