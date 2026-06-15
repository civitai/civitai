import type { NextApiRequest, NextApiResponse } from 'next';
import NextAuth from 'next-auth';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { callbackCookieName, civitaiTokenCookieName } from '~/libs/auth';
import { deleteEncryptedCookie } from '~/server/utils/cookie-encryption';
import { invalidateToken } from '~/server/auth/token-tracking';
import { generationServiceCookie } from '~/shared/constants/generation.constants';
import { runLoginSideEffects } from '~/server/auth/login-side-effects';
import { createLogger } from '~/utils/logging';
import { createAuthOptions } from '~/server/auth/next-auth-options';

const log = createLogger('nextauth', 'blue');

function isValidCallbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    // Accept http(s) absolute or relative paths anchored at /
    if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) return true;
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export default async function auth(req: NextApiRequest, res: NextApiResponse) {
  // 5xx attribution: this login handler bypasses the endpoint wrappers, so its
  // 500s were counter-blind. Listener-only (res.once('finish')); no behavior change.
  instrumentApiResponse(req, res);
  // console.log(new Date().toISOString() + ' ::', 'nextauth', req.url);
  const customAuthOptions = createAuthOptions(req);

  // Strip any malformed callback-url cookie (either secure-prefixed or plain)
  // before next-auth's assertConfig rejects every request with
  // INVALID_CALLBACK_URL_ERROR.
  const callbackCookieCandidates = [
    callbackCookieName,
    'next-auth.callback-url',
    '__Secure-next-auth.callback-url',
  ];
  const clearCookies: string[] = [];
  for (const name of callbackCookieCandidates) {
    const value = req.cookies[name];
    if (value && !isValidCallbackUrl(value)) {
      delete req.cookies[name];
      clearCookies.push(
        `${name}=; Path=/; Max-Age=0; SameSite=Lax${
          name.startsWith('__Secure-') ? '; Secure' : ''
        }`
      );
    }
  }
  if (clearCookies.length) res.setHeader('Set-Cookie', clearCookies);

  // Yes, this is intended. Without this, you can't log in to a user
  // while already logged in as another
  if (req.url?.startsWith('/api/auth/callback/')) {
    const callbackUrl = req.cookies[callbackCookieName];
    if (!callbackUrl?.includes('connect=true')) delete req.cookies[civitaiTokenCookieName];
  }

  customAuthOptions.events ??= {};

  customAuthOptions.events.signOut = async ({ token }) => {
    // Invalidate the token
    await invalidateToken(token);
    // Delete encrypted cookies
    deleteEncryptedCookie({ req, res }, { name: generationServiceCookie.name });
  };

  // STEP-H-REMOVAL: this event wiring goes away with next-auth; the side-effects themselves live in
  // runLoginSideEffects (also invoked by /api/auth/post-login on the hub path) and stay.
  customAuthOptions.events.signIn = async (context) => {
    await runLoginSideEffects({
      req,
      res,
      userId: Number(context.user.id),
      isNewUser: !!context.isNewUser,
    });
  };

  return await NextAuth(req, res, customAuthOptions);
}
