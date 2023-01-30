import { NextApiRequest } from 'next';
// Wrapper for unstable_getServerSession https://next-auth.js.org/configuration/nextjs

import type { GetServerSidePropsContext } from 'next';
import { getServerSession } from 'next-auth/next';
import { createAuthOptions } from '~/pages/api/auth/[...nextauth]';

// Next API route example - /pages/api/restricted.ts
export const getServerAuthSession = async (ctx: {
  req: GetServerSidePropsContext['req'];
  res: GetServerSidePropsContext['res'];
}) => getServerSession(ctx.req, ctx.res, createAuthOptions(ctx.req as NextApiRequest));
