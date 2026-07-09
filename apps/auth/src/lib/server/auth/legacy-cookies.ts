import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { cookieDomain } from './cookie';

// Clear the LEGACY next-auth cookies that may still sit on `.civitai.com` from the pre-hub main app. The SESSION
// cookie (`civitai-token` / prod `__Secure-civitai-token`) is the one that matters: the main app's hybrid
// session fallback still HONORS it, so a surviving one silently re-authenticates the user after logout — the
// rest (CSRF / callback-url / OAuth state / PKCE / nonce) are non-authenticating cruft we de-crud for good
// measure. The hub runs on `.civitai.com`, so — unlike a cross-site `.red` spoke, whose response can't touch a
// `.civitai.com` cookie — it CAN clear these, and the cross-domain logout flow lands here, so this is where the
// `.civitai.com` legacy cookies get torn down. Mirrors the main app's clearLegacyCookies (src/server/auth/
// civ-cookie.ts). Drop this whole helper once legacy cookies have aged out post-cutover.
//
// Cleared across EVERY scope next-auth could have set them on: host-only (undefined), the explicit
// NEXTAUTH_COOKIE_DOMAIN, and the hub's registrable domain (Domain-scoped to `.civitai.com` — that's why the
// hub can see them at all). The host-only scope is the load-bearing one: a Domain-scoped delete CANNOT remove a
// host-only cookie of the same name, and a surviving host-only legacy SESSION cookie silently re-authenticates
// the user via the main app's hybrid fallback after logout (the documented "stale host-only cookie shadow"
// hazard). SvelteKit 2.x keys queued cookies by (domain, path, name) — see generate_cookie_key in
// runtime/server/cookie.js — so clearing the same name on multiple Domain scopes emits a Set-Cookie for EACH
// (they no longer overwrite, unlike the older API this comment used to assume). Mirrors the main app's
// legacyClearScopes (src/server/auth/civ-cookie.ts). The host-only CSRF cookie (`__Host-` prefix forbids a
// Domain attribute) is cleared host-only. `secure: true` is set explicitly for `__Secure-`/`__Host-` names so
// SvelteKit doesn't reject the prefix in a dev (http) build where it would otherwise default secure to false.
export function clearLegacyCookies(cookies: Cookies): void {
  // Distinct Domain scopes, host-only (undefined) first. `cookieDomain()` is the registrable `.civitai.com`.
  const scopes = Array.from(
    new Set<string | undefined>([
      undefined,
      env.NEXTAUTH_COOKIE_DOMAIN || undefined,
      cookieDomain(),
    ])
  );
  const del = (name: string, secure: boolean, domain?: string) =>
    cookies.delete(name, { path: '/', secure, ...(domain ? { domain } : {}) });
  const delAllScopes = (name: string, secure: boolean) => {
    for (const domain of scopes) del(name, secure, domain);
  };

  // CSRF — host-only only (next-auth set the plain one host-only; the `__Host-` variant's prefix forbids Domain).
  del('next-auth.csrf-token', false);
  del('__Host-next-auth.csrf-token', true);

  // Session cookie + the transient OAuth/OIDC cruft — clear across every scope (incl. host-only).
  const names: ReadonlyArray<readonly [string, boolean]> = [
    ['civitai-token', false],
    ['__Secure-civitai-token', true],
    ['next-auth.callback-url', false],
    ['__Secure-next-auth.callback-url', true],
    ['next-auth.state', false],
    ['__Secure-next-auth.state', true],
    ['next-auth.pkce.code_verifier', false],
    ['__Secure-next-auth.pkce.code_verifier', true],
    ['next-auth.nonce', false],
    ['__Secure-next-auth.nonce', true],
  ];
  for (const [name, secure] of names) delAllScopes(name, secure);
}
