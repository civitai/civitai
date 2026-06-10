import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clearSession } from '$lib/server/auth/session';
import { sessions } from '$lib/server/auth/registry';
import { readReturnUrl } from '$lib/server/auth/redirect';

// Logout: invalidate the session marker (so every spoke rejects this token immediately, not just
// after it expires) and clear the cookie. locals.tokenId is set by hooks from the verified cookie.
async function logout(
  cookies: Parameters<RequestHandler>[0]['cookies'],
  locals: App.Locals,
  url: URL
): Promise<never> {
  if (locals.tokenId) {
    await sessions.invalidateToken(locals.tokenId, locals.user?.id).catch(() => {});
  }
  clearSession(cookies);
  const returnUrl = readReturnUrl(url);
  redirect(302, returnUrl && returnUrl !== '/' ? returnUrl : '/login');
}

export const POST: RequestHandler = ({ cookies, locals, url }) => logout(cookies, locals, url);
export const GET: RequestHandler = ({ cookies, locals, url }) => logout(cookies, locals, url);
