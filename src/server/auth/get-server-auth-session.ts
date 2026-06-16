import type { GetServerSidePropsContext, NextApiRequest, NextApiResponse } from 'next';
import type { Session } from 'next-auth';
import { getServerSession } from 'next-auth/next';
import { env } from '~/env/server';
import { createAuthOptions } from './next-auth-options';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { getSessionFromBearerToken } from './bearer-token';
import { SESSION_REFRESH_HEADER, SESSION_REFRESH_COOKIE } from '~/shared/constants/auth.constants';
import { REDIS_SYS_KEYS, sysRedis, withRedisCommandTimeout } from '~/server/redis/client';
import { callbackCookieName } from '~/libs/auth';

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
        // Per-command timeout so a silent sysRedis half-open can't park this read (the
        // sys client has no socketTimeout). Single command → withRedisCommandTimeout's
        // AbortSignal bounds it; the surrounding try/catch keeps the best-effort contract.
        const cause = await withRedisCommandTimeout(sysRedis).get(
          `${REDIS_SYS_KEYS.SESSION.REFRESH_CAUSE}:${userId}`
        );
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
