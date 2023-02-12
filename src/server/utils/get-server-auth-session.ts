import { NextApiRequest } from 'next';
// Wrapper for unstable_getServerSession https://next-auth.js.org/configuration/nextjs

import type { GetServerSidePropsContext } from 'next';
import { getServerSession } from 'next-auth/next';
import { createAuthOptions } from '~/pages/api/auth/[...nextauth]';
import { getSessionFromBearerToken } from '~/server/utils/session-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';

// Next API route example - /pages/api/restricted.ts
export const getServerAuthSession = async ({
  req,
  res,
}: {
  req: GetServerSidePropsContext['req'];
  res: GetServerSidePropsContext['res'];
}) => {
  // Try getting session based on token
  let token: string | undefined;
  if (req.headers.authorization) token = req.headers.authorization.split(' ')[1];
  else if (req.url) {
    const url = new URL(req.url, getBaseUrl());
    token = url.searchParams.get('token') || undefined;
  }

  if (token) return await getSessionFromBearerToken(token);
  return getServerSession(req, res, createAuthOptions(req as NextApiRequest));
};
