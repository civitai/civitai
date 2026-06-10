import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clearSession } from '$lib/server/auth/session';
import { sessions } from '$lib/server/auth/registry';
import { readReturnUrl } from '$lib/server/auth/redirect';

// Logout: invalidate the session marker (so every spoke rejects this token immediately, not just
// after it expires) and clear the cookie. locals.tokenId is set by hooks from the verified cookie.
//
// POST-only on purpose: a GET logout is CSRF-able (`<img src=".../logout">` would log users out).
// SvelteKit's built-in CSRF origin check covers same-origin form POSTs; the login page submits a
// real <form method="POST"> for the "Log out" button.
export const POST: RequestHandler = async ({ cookies, locals, url }) => {
  if (locals.tokenId) {
    await sessions.invalidateToken(locals.tokenId, locals.user?.id).catch(() => {});
  }
  clearSession(cookies);
  const returnUrl = readReturnUrl(url);
  redirect(302, returnUrl && returnUrl !== '/' ? returnUrl : '/login');
};
