import type { GetServerSidePropsContext, NextApiRequest, NextApiResponse } from 'next';
import type { Session } from 'next-auth';
import { getServerSession } from 'next-auth/next';
import { env } from '~/env/server';
import { createAuthOptions } from './next-auth-options';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { getSessionFromBearerToken } from './bearer-token';
import { SESSION_REFRESH_HEADER } from '~/shared/constants/auth.constants';

type AuthRequest = (GetServerSidePropsContext['req'] | NextApiRequest) & {
  context?: Record<string, unknown>;
};
type AuthResponse = GetServerSidePropsContext['res'] | NextApiResponse;

/**
 * Check if session has needsCookieRefresh flag and set response header if so.
 * This signals to the client that it should refresh its session cookie.
 * The flag is deleted after use so it doesn't appear in the returned session.
 */
function checkAndSetSessionHeaders(session: Session | null, res: AuthResponse): Session | null {
  if ((session as any)?.needsCookieRefresh) {
    res.setHeader(SESSION_REFRESH_HEADER, 'true');
    delete (session as any).needsCookieRefresh;
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
    if (!req.context?.session) req.context.session = await getSessionFromBearerToken(token);
    return req.context.session as Session | null;
  }
  try {
    const authOptions = createAuthOptions(req);
    const session = await getServerSession(req, res, authOptions);
    req.context.session = checkAndSetSessionHeaders(session, res);

    return req.context.session as Session | null;
  } catch (error) {
    return null;
  }
};
