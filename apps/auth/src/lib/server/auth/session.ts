import { randomUUID } from 'crypto';
import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import {
  maybeCreateSessionSigner,
  sessionCookieName,
  type SessionSigner,
  type SessionUser,
} from '@civitai/auth';
import { sessions } from './registry';

// THE thin-session cookie — a shared contract: every app must use this exact name for SSO to work, so
// it's a hardcoded constant (via the package's single-source-of-truth helper), NOT configurable.
// `civ-token` in dev, `__Secure-civ-token` in prod. DISTINCT from the legacy next-auth `civitai-token`
// cookie, so the two never collide during the cutover.
export const SESSION_COOKIE = sessionCookieName(!dev);

let _signer: SessionSigner | null | undefined;
/** The hub ES256 signer. Throws a clear error if the keys aren't configured. */
export function getSigner(): SessionSigner {
  if (_signer === undefined) _signer = maybeCreateSessionSigner();
  if (!_signer) {
    throw new Error(
      '[auth-app] hub signer not configured — set AUTH_JWT_PRIVATE_KEY, AUTH_JWT_KID (+ AUTH_JWT_ISSUER, AUTH_JWT_PUBLIC_KEY)'
    );
  }
  return _signer;
}

// Minimal DB-row → SessionUser projection. Mirrors getSessionUser in the main app, but the
// hub only needs identity-level claims; spokes re-derive the rest on first request if needed.
export function toSessionUser(row: {
  id: number;
  username: string | null;
  email: string | null;
  emailVerified: Date | string | null;
  image: string | null;
  isModerator: boolean | null;
  showNsfw: boolean;
  blurNsfw: boolean;
  browsingLevel: number;
  onboarding: number;
  createdAt: Date | string;
  deletedAt: Date | string | null;
  muted: boolean;
  bannedAt: Date | string | null;
}): SessionUser {
  return {
    id: row.id,
    username: row.username ?? undefined,
    email: row.email ?? undefined,
    emailVerified: row.emailVerified ? new Date(row.emailVerified) : undefined,
    image: row.image ?? undefined,
    isModerator: row.isModerator ?? false,
    showNsfw: row.showNsfw,
    blurNsfw: row.blurNsfw,
    browsingLevel: row.browsingLevel,
    onboarding: row.onboarding,
    createdAt: new Date(row.createdAt),
    deletedAt: row.deletedAt ? new Date(row.deletedAt) : undefined,
    muted: row.muted,
    bannedAt: row.bannedAt ? new Date(row.bannedAt) : undefined,
  };
}

/** Mint the THIN ES256 session JWT (identity only — `sub`/`jti`/`signedAt`, NO embedded user) and set it as
 *  the cross-subdomain cookie. The rich user is resolved per-request from the shared cache (the hub
 *  produces it), so the cookie stays small and every root resolves from one source. */
export async function establishSession(cookies: Cookies, user: SessionUser): Promise<void> {
  const signer = getSigner();
  const tokenId = randomUUID();
  const token = await signer.mintSessionToken(
    { signedAt: Date.now(), sub: String(user.id) },
    { jti: tokenId } // the session/token id is the standard `jti` claim — no duplicate `id`
  );
  cookies.set(SESSION_COOKIE, token, {
    path: '/',
    domain: env.AUTH_COOKIE_DOMAIN || undefined, // e.g. .civitai.com
    httpOnly: true,
    secure: !dev,
    sameSite: 'lax',
    maxAge: signer.maxAge,
  });

  // Best-effort: track the token so it can be invalidated later (logout / ban). A redis blip
  // must not fail login.
  await sessions.trackToken(tokenId, user.id).catch(() => {});
}

export function clearSession(cookies: Cookies): void {
  cookies.delete(SESSION_COOKIE, { path: '/', domain: env.AUTH_COOKIE_DOMAIN || undefined });
}
