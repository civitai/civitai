import { redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import { clearSession } from '$lib/server/auth/session';
import { clearDeviceCookie } from '$lib/server/auth/device';
import { sessions } from '$lib/server/auth/registry';
import { readReturnUrl, buildPostLoginRedirect } from '$lib/server/auth/redirect';
import { buildPostLoginOriginCheck } from '$lib/server/oauth/first-party';

// Logout: invalidate the session marker (so every spoke rejects this token immediately, not just after it
// expires), clear the hub's `.civitai.com` cookies, and redirect back. locals.tokenId is set by hooks from the
// verified cookie.
//
// POST does the real work — POST-only on purpose: it's the CSRF-protected logout. SvelteKit's built-in CSRF
// origin check covers SAME-ORIGIN form POSTs; the login page + admin layout both submit a real
// <form method="POST" action="/logout"> for their sign-out buttons. The token-revoke + cookie-clear only ever
// happen here.
//
// GET is the CROSS-DOMAIN-logout LANDING page: a cross-site spoke (civitai.red) can't clear the hub's
// `.civitai.com` cookies or revoke the hub session itself, and can't POST here directly (cross-origin form POST
// is CSRF-blocked). So it sends the browser here via a top-level GET; we render a SAME-ORIGIN auto-submitting
// POST form that finishes the logout (passing CSRF) and lands back on the spoke.
//
// ACCEPTED TRADEOFF: routing cross-domain logout through a GET means logout is reachable by a top-level
// navigation, i.e. a forced-logout (logout-CSRF) surface — an attacker can navigate a victim here and sign them
// out. Impact is bounded to session-DoS: `returnUrl` is registry-validated (no redirect to an attacker origin),
// there's no privilege/data exposure, and the worst case is the user re-logging in. The alternative (a
// spoke-signed one-time token verified here) is a possible future hardening; deliberately not done for a
// DoS-only risk. The GET path performs NO state change by itself — only the same-origin POST it submits does.

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const GET: RequestHandler = async ({ url }) => {
  const returnUrl = url.searchParams.get('returnUrl') ?? '';
  // Forward returnUrl in the POST action; it's VALIDATED at POST time against the trusted-spoke registry.
  const action = '/logout' + (returnUrl ? `?returnUrl=${encodeURIComponent(returnUrl)}` : '');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Signing out…</title>
<style>body{background:#0b0c10;color:#e8eaed;font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}</style>
</head><body>
<form id="logout" method="POST" action="${escapeAttr(
    action
  )}"><noscript><button type="submit">Click to finish signing out</button></noscript></form>
<p>Signing you out…</p>
<script>document.getElementById('logout').submit()</script>
</body></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
};

export const POST: RequestHandler = async ({ cookies, locals, url }) => {
  if (locals.tokenId) {
    await sessions.invalidateToken(locals.tokenId, locals.user?.id).catch(() => {});
  }
  // Clear the hub's `.civitai.com` session AND device cookies (the seamless-switch account set must not survive
  // logout on a shared machine — mirrors the spoke's buildLogoutCookies).
  clearSession(cookies);
  clearDeviceCookie(cookies);

  // The returnUrl can be a CROSS-SITE spoke absolute URL (the .red logout sends the browser here), so it MUST be
  // validated against the trusted-spoke registry — an unvalidated redirect here would be an open redirect. Same
  // guard the post-LOGIN redirect uses; falls back to /login when the target isn't a trusted spoke origin.
  const returnUrl = readReturnUrl(url);
  const isAllowedOrigin = await buildPostLoginOriginCheck();
  const target = buildPostLoginRedirect(returnUrl, null, url.origin, dev, isAllowedOrigin);
  redirect(302, target && target !== '/' ? target : '/login');
};
