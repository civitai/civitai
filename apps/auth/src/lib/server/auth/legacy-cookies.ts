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
// Cleared over the single domain next-auth scoped them to: NEXTAUTH_COOKIE_DOMAIN if set, else the registrable
// domain (these are Domain-scoped to `.civitai.com` — that's why the hub can see them at all). One scope per
// name because SvelteKit's cookies API keys by name, so a second delete of the same name would overwrite the
// first. The host-only CSRF cookie (`__Host-` prefix forbids a Domain attribute) is cleared host-only.
// `secure: true` is set explicitly for `__Secure-`/`__Host-` names so SvelteKit doesn't reject the prefix in a
// dev (http) build where it would otherwise default secure to false.
export function clearLegacyCookies(cookies: Cookies): void {
  const domain = env.NEXTAUTH_COOKIE_DOMAIN || cookieDomain();
  const del = (name: string, secure: boolean, scoped: boolean) =>
    cookies.delete(name, { path: '/', secure, ...(scoped && domain ? { domain } : {}) });

  // CSRF — host-only (next-auth set it host-only; the `__Host-` variant's prefix forbids Domain anyway).
  del('next-auth.csrf-token', false, false);
  del('__Host-next-auth.csrf-token', true, false);

  // Session cookie + the transient OAuth/OIDC cruft — Domain-scoped.
  const scopedPairs: ReadonlyArray<readonly [string, boolean]> = [
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
  for (const [name, secure] of scopedPairs) del(name, secure, true);
}
