import {
  DEVICE_COOKIE_BASE,
  HOST_COOKIE_PREFIX,
  LEGACY_SESSION_COOKIE_BASE,
  SECURE_COOKIE_PREFIX,
  SESSION_COOKIE_BASE,
  type SessionCookieMode,
} from './constants';

// Single source of truth for the auth cookie names — the hub sets them, the main app sets them, and every
// spoke reads them. The `__Secure-` prefix is a browser-enforced HTTPS-only guarantee, applied when secure
// (prod) and dropped for dev (http localhost).
export const cookiePrefix = (secure: boolean): string => (secure ? SECURE_COOKIE_PREFIX : '');

/**
 * Whether auth cookies are secure (the `Secure` attribute + the `__Secure-` name prefix). This follows the
 * APP's OWN serving protocol — `NEXT_PUBLIC_BASE_URL` for a Next spoke (each spoke sets/reads its own cookie),
 * falling back to the hub issuer (`AUTH_JWT_ISSUER`, which the hub sets to its own origin). The distinction
 * matters cross-domain: a localhost (http) spoke talking to the prod (https) hub must use a NON-secure cookie
 * even though the issuer is https. Read straight off `process.env` so it's safe at module load.
 *
 * NB: TRUTHINESS (`||`), not `??` — an EMPTY-string `NEXT_PUBLIC_BASE_URL` must fall through to
 * `AUTH_JWT_ISSUER`. `??` only falls through on null/undefined, so a `NEXT_PUBLIC_BASE_URL=""` (present but
 * empty, common in shared env files) would resolve to `''` → `false` on an HTTPS deploy → the cookie silently
 * loses its `__Secure-` prefix and two apps compute DIFFERENT cookie names → they can't read each other's
 * session (the test-site redirect-loop class of bug). Warn loudly if NEITHER is set.
 */
let warnedNoCookieBase = false;
export const isSecureCookie = (): boolean => {
  const base = process.env.NEXT_PUBLIC_BASE_URL || process.env.AUTH_JWT_ISSUER || '';
  if (!base && !warnedNoCookieBase) {
    warnedNoCookieBase = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[@civitai/auth] neither NEXT_PUBLIC_BASE_URL nor AUTH_JWT_ISSUER is set — auth cookies default to ' +
        'NON-secure naming, which mismatches a secure (https) deploy and breaks cross-app session sharing. ' +
        "Set one to this app's own origin."
    );
  }
  return base.startsWith('https://');
};

// `secure` defaults to the env-derived value, so call sites can just use `sessionCookieName()` — pass an
// explicit boolean only to override (tests, or clearing BOTH prefixes on logout).
export const sessionCookieName = (secure: boolean = isSecureCookie()): string =>
  `${cookiePrefix(secure)}${SESSION_COOKIE_BASE}`;

export const deviceCookieName = (secure: boolean = isSecureCookie()): string =>
  `${cookiePrefix(secure)}${DEVICE_COOKIE_BASE}`;

// Legacy NextAuth session cookie name — resolved with the SAME dev/prod secure logic as the hub cookie above,
// so prod reads `__Secure-civitai-token` and dev reads `civitai-token`. READ-ONLY during the cutover.
export const legacySessionCookieName = (secure: boolean = isSecureCookie()): string =>
  `${cookiePrefix(secure)}${LEGACY_SESSION_COOKIE_BASE}`;

// Every name a cookie with this base can live under (dev, `__Secure-`, `__Host-`), for logout to expire all.
export const allCookieNames = (base: string): string[] => [
  base,
  `${SECURE_COOKIE_PREFIX}${base}`,
  `${HOST_COOKIE_PREFIX}${base}`,
];

/** Pull a single cookie value out of a `Cookie` header string. */
export function readCookie(header: string, name: string): string | undefined {
  return parseCookieHeader(header)[name];
}

/**
 * Every cookie in a `Cookie` header string, by name. The first occurrence of a repeated name wins, and a malformed
 * %-escape keeps its raw value rather than throwing out of a caller such as logout.
 */
export function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name || name in out) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

// ── Host-only session cookie ──────────────────────────────────────────────────────────────────────────────
// Each app moves from the shared slot (`__Secure-civ-token`, Domain=<registrable>) to a host-only slot
// (`__Host-civ-token`) when its AUTH_SESSION_COOKIE_MODE flips to `host`. Until every app has moved, readers accept
// both slots, so the order the apps flip in never signs anyone out. Dev (http) has no prefix, so both slots
// share the bare name there.

/** This app's cookie mode. Anything but `host` is `shared` (the default), so an unset or mistyped value is inert. */
export const sessionCookieMode = (): SessionCookieMode =>
  process.env.AUTH_SESSION_COOKIE_MODE === 'host' ? 'host' : 'shared';

/** Whether the shared slot is still read. AUTH_LEGACY_READ defaults to true; only an explicit false turns it off. */
export const legacyCookieReadEnabled = (): boolean =>
  !/^(false|0|off|no)$/i.test((process.env.AUTH_LEGACY_READ ?? '').trim());

export const hostSessionCookieName = (secure: boolean = isSecureCookie()): string =>
  `${secure ? HOST_COOKIE_PREFIX : ''}${SESSION_COOKIE_BASE}`;

export const hostDeviceCookieName = (secure: boolean = isSecureCookie()): string =>
  `${secure ? HOST_COOKIE_PREFIX : ''}${DEVICE_COOKIE_BASE}`;

export type CookieSlot = SessionCookieMode;

/** A cookie value plus the name and slot it was read from, so a writer can put it back where it came from. */
export interface CookieRead {
  value: string;
  name: string;
  slot: CookieSlot;
}

export interface CookieReadOptions {
  mode?: SessionCookieMode;
  secure?: boolean;
  legacyRead?: boolean;
}

type CookieJar = Partial<Record<string, string | undefined>> | undefined | null;

export const sessionCookieNameForSlot = (slot: CookieSlot, secure: boolean = isSecureCookie()) =>
  slot === 'host' ? hostSessionCookieName(secure) : sessionCookieName(secure);

export const deviceCookieNameForSlot = (slot: CookieSlot, secure: boolean = isSecureCookie()) =>
  slot === 'host' ? hostDeviceCookieName(secure) : deviceCookieName(secure);

// Presence-based: the mode's own slot wins whenever it is present, valid or not; the other slot is read only
// when the mode's slot is absent. Validity is never consulted, so a stale cookie in one slot can't make the
// reader pick a different identity from the other.
function readSlot(
  cookies: CookieJar,
  nameFor: (slot: CookieSlot, secure: boolean) => string,
  opts: CookieReadOptions
): CookieRead | null {
  const mode = opts.mode ?? sessionCookieMode();
  const secure = opts.secure ?? isSecureCookie();
  const legacyRead = opts.legacyRead ?? legacyCookieReadEnabled();
  const order: CookieSlot[] = mode === 'host' ? ['host', 'shared'] : ['shared', 'host'];
  for (const slot of order) {
    if (slot === 'shared' && !legacyRead) continue;
    const name = nameFor(slot, secure);
    const value = cookies?.[name];
    if (value) return { value, name, slot };
  }
  return null;
}

/** The session token this request carries, and where it was read from. */
export const readSessionToken = (cookies: CookieJar, opts: CookieReadOptions = {}) =>
  readSlot(cookies, sessionCookieNameForSlot, opts);

/** The device id this request carries, and where it was read from. */
export const readDeviceId = (cookies: CookieJar, opts: CookieReadOptions = {}) =>
  readSlot(cookies, deviceCookieNameForSlot, opts);

/**
 * Where a refreshed token is written: under the name it was read from. A token read from the host-only slot is
 * rolled there in either mode. A token read from the shared slot is rolled there in shared mode (as today), and
 * in host mode is served as-is, never copied into the host-only slot; the next navigation re-syncs it.
 */
export const rollSlot = (
  read: Pick<CookieRead, 'slot'>,
  mode: SessionCookieMode = sessionCookieMode()
): CookieSlot | null => (read.slot === 'host' ? 'host' : mode === 'shared' ? 'shared' : null);
