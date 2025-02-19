import type { GetServerSidePropsContext } from 'next';
import type { Session } from 'next-auth';
import { getServerSession } from 'next-auth/next';
import { env } from '~/env/server';
import { createAuthOptions } from '~/pages/api/auth/[...nextauth]';
import { getSessionFromBearerToken } from '~/server/utils/session-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';

// Next API route example - /pages/api/restricted.ts
export const getServerAuthSession = async ({
  req,
  res,
}: {
  req: GetServerSidePropsContext['req'] & { context?: Record<string, unknown> };
  res: GetServerSidePropsContext['res'];
}) => {
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
    req.context.session = session;
    return session;
  } catch (error) {
    return null;
  }
};
