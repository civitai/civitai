import { allCookieNames, SESSION_COOKIE_BASE } from '@civitai/auth/client';

/** Every slot a session cookie can live under: dev, `__Secure-` and `__Host-`. */
const SESSION_COOKIE_NAMES = new Set(allCookieNames(SESSION_COOKIE_BASE));

/** Keep only the session cookies of a raw `Cookie` header (same `name=value` text, `; `-joined). */
// Hand-split rather than `parseCookieHeader` on purpose: that decodes %-escapes, and a receiver
// must get the cookie bytes exactly as the browser sent them.
export function pickSessionCookies(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept: string[] = [];
  for (const part of header.split(';')) {
    const pair = part.trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    if (SESSION_COOKIE_NAMES.has(pair.slice(0, eq).trim())) kept.push(pair);
  }
  return kept.length ? kept.join('; ') : undefined;
}
