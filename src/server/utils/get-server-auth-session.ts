import type { GetServerSidePropsContext } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '~/pages/api/auth/[...nextauth]';
import { getSessionFromBearerToken } from '~/server/utils/session-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { Session } from 'next-auth';

// Next API route example - /pages/api/restricted.ts
export const getServerAuthSession = async ({
  req,
  res,
}: {
  req: GetServerSidePropsContext['req'] & { context?: Record<string, unknown> };
  res: GetServerSidePropsContext['res'];
}) => {
  // Try getting session based on token
  let token: string | undefined;
  if (req.headers.authorization) token = req.headers.authorization.split(' ')[1];
  else if (req.url) {
    const url = new URL(req.url, getBaseUrl());
    token = url.searchParams.get('token') || undefined;
  }

  if (token) {
    if (!req.context) req.context = {};
    if (!req.context?.session) req.context.session = await getSessionFromBearerToken(token);
    return req.context.session as Session | null;
  }
  try {
    const session = await getServerSession(req, res, authOptions);
    return session;
  } catch (error) {
    return null;
  }
};
