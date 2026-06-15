import type { GetServerSidePropsContext, NextApiRequest, NextApiResponse } from 'next';
// STEP-H-REMOVAL: `getServerSession` + `createAuthOptions` (and the legacy block that uses them) are deleted
// when NextAuth is removed. The `Session` type must be REPLACED with a first-party session type, not just
// deleted — it's the return type across this module and nearly every server-side auth consumer.
import type { Session } from 'next-auth';
import { getServerSession } from 'next-auth/next';
import { env } from '~/env/server';
import { createAuthOptions } from './next-auth-options';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { getSessionFromBearerToken } from './bearer-token';
import { SESSION_REFRESH_HEADER, SESSION_REFRESH_COOKIE } from '~/shared/constants/auth.constants';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { callbackCookieName } from '~/libs/auth';
import { sessionCookieName, deviceCookieName } from '@civitai/auth';
import { USE_HUB_SESSION, getHubSession, maybeRollHubCookie } from './session-client';

function isValidCallbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) return true;
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

type AuthRequest = (GetServerSidePropsContext['req'] | NextApiRequest) & {
  context?: Record<string, unknown>;
};
type AuthResponse = GetServerSidePropsContext['res'] | NextApiResponse;

/**
 * Check if session has needsCookieRefresh flag and set response header/cookie if so.
 * This signals to the client that it should refresh its session cookie.
 * The flag is deleted after use so it doesn't appear in the returned session.
 */
async function checkAndSetSessionHeaders(
  session: Session | null,
  res: AuthResponse
): Promise<Session | null> {
  if (session?.needsCookieRefresh) {
    res.setHeader(SESSION_REFRESH_HEADER, 'true');
    // Also set a cookie that persists across page refreshes (5 min expiry)
    res.setHeader(
      'Set-Cookie',
      `${SESSION_REFRESH_COOKIE}=true; Path=/; Max-Age=300; SameSite=Lax`
    );
    // Best-effort: surface the original refreshSession() caller stack to the
    // client so we can identify unexpected sources from DevTools.
    try {
      const userId = session.user?.id;
      if (userId) {
        const cause = await sysRedis.get(`${REDIS_SYS_KEYS.SESSION.REFRESH_CAUSE}:${userId}`);
        if (cause) res.setHeader('x-session-refresh-cause', cause);
      }
    } catch {}
    delete session.needsCookieRefresh;
  }
  return session;
}

// Next API route example - /pages/api/restricted.ts
export const getServerAuthSession = async ({
  req,
  res,
}: {
  req: AuthRequest;
  res: AuthResponse;
}): Promise<Session | null> => {
  if (req.context?.session) return req.context.session as Session | null;

  // Try getting session based on token
  let token: string | undefined;
  if (req.headers.authorization) token = req.headers.authorization.split(' ')[1];
  else if (req.url) {
    const url = new URL(req.url, getBaseUrl());
    if (url.searchParams.get('token') !== env.WEBHOOK_TOKEN)
      token = url.searchParams.get('token') || undefined;
  }

  if (!req.context) req.context = {};
  if (token) {
    if (!req.context?.session) {
      const result = await getSessionFromBearerToken(token);
      req.context.session = result;
      if (result && 'tokenScope' in result) {
        req.context.tokenScope = result.tokenScope;
        req.context.buzzLimit = (result as any).buzzLimit ?? null;
        req.context.apiKeyId = (result as any).apiKeyId ?? null;
        req.context.subject = (result as any).subject ?? null;
      }
    }
    return req.context.session as Session | null;
  }

  // Thin-session cutover (flag, default OFF): resolve the cookie session via the centralized hub
  // (verify → shared cache → hub on miss) instead of next-auth.
  // HYBRID FALLBACK: if there's no civ-token (or the hub can't resolve it), fall THROUGH to the legacy
  // next-auth path below rather than returning null — so a user still carrying the old next-auth cookie
  // stays authorized through the transition (no forced mass re-login). New logins mint a civ-token at the
  // hub; legacy cookies age out. See docs/main-app-auth-cutover.md.
  if (USE_HUB_SESSION) {
    const session = await getHubSession(req).catch(() => null);
    if (session) {
      req.context.session = session;
      // Rolling-session refresh (best-effort, fire-safe — cutover doc section C). Only does work when the
      // token has crossed AUTH_SESSION_UPDATE_AGE; otherwise it's a cheap iat decode + age check.
      const civ = req.cookies?.[sessionCookieName()];
      const device = req.cookies?.[deviceCookieName()];
      if (civ) await maybeRollHubCookie(civ, device, res);
      return session;
    }
    // no civ-token → fall through to the legacy next-auth cookie below
  }

  // STEP-H-REMOVAL: this entire legacy block (getServerSession + callback-cookie scrubbing +
  // checkAndSetSessionHeaders) is deleted at step H; the USE_HUB_SESSION branch above becomes unconditional.
  try {
    // Strip any malformed next-auth.callback-url cookie before next-auth's
    // assertConfig rejects the request with INVALID_CALLBACK_URL_ERROR.
    const reqCookies = (req as NextApiRequest).cookies as
      | Record<string, string | undefined>
      | undefined;
    if (reqCookies) {
      const candidates = [
        callbackCookieName,
        'next-auth.callback-url',
        '__Secure-next-auth.callback-url',
      ];
      const clearCookies: string[] = [];
      for (const name of candidates) {
        const value = reqCookies[name];
        if (value && !isValidCallbackUrl(value)) {
          delete reqCookies[name];
          clearCookies.push(
            `${name}=; Path=/; Max-Age=0; SameSite=Lax${
              name.startsWith('__Secure-') ? '; Secure' : ''
            }`
          );
        }
      }
      if (clearCookies.length) {
        try {
          (res as NextApiResponse).setHeader?.('Set-Cookie', clearCookies);
        } catch {}
      }
    }

    const authOptions = createAuthOptions(req);
    const session = await getServerSession(req, res, authOptions);
    req.context.session = await checkAndSetSessionHeaders(session, res);

    return req.context.session as Session | null;
  } catch (error) {
    return null;
  }
};
