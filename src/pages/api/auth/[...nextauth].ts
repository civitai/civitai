import { PrismaAdapter } from '@next-auth/prisma-adapter';
import { User } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import NextAuth, { Session, type NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import DiscordProvider from 'next-auth/providers/discord';
import GithubProvider from 'next-auth/providers/github';
import GoogleProvider from 'next-auth/providers/google';
import RedditProvider from 'next-auth/providers/reddit';
import EmailProvider from 'next-auth/providers/email';
import { deleteCookie, getCookie, setCookie } from 'cookies-next';

import { env } from '~/env/server.mjs';
import { prisma } from '~/server/db/client';
import { getRandomInt } from '~/utils/number-helpers';
import { sendVerificationRequest } from '~/server/auth/verificationEmail';
import { refreshToken } from '~/server/utils/session-helpers';

const setUserName = async (email: string) => {
  try {
    const { username } = await prisma.user.update({
      where: { email },
      data: {
        username: `${email.split('@')[0]}${getRandomInt(100, 999)}`,
      },
      select: {
        username: true,
      },
    });
    return username ? username : undefined;
  } catch (e) {
    return undefined;
  }
};

const isProduction = env.NODE_ENV === 'production';

export const createAuthOptions = (req: NextApiRequest): NextAuthOptions => ({
  adapter: PrismaAdapter(prisma),
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  events: {
    createUser: async ({ user }) => {
      if (!user.email) throw new Error('There is no email associated with this account');

      let username: string | undefined = undefined;
      while (!username) {
        username = await setUserName(user.email);
      }
    },
  },
  callbacks: {
    jwt: async ({ token, user }) => {
      if (req.url === '/api/auth/session?update') {
        const user = await prisma.user.findUnique({ where: { id: Number(token.sub) } });
        token.user = user;
        token.signedAt = Date.now();
      } else {
        // have to do this to be able to connect to other providers
        token.sub = Number(token.sub) as any; //eslint-disable-line
        if (user) token.user = user;
      }

      const { deletedAt, ...restUser } = token.user as User;
      token.user = { ...restUser };

      return token;
    },
    session: async ({ session, token }) => {
      const localSession = { ...session };
      token = await refreshToken(token);
      if (token.user) localSession.user = token.user as Session['user'];
      return localSession;
    },
  },
  // Configure one or more authentication providers
  providers: [
    DiscordProvider({
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
    }),
    GithubProvider({
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
    GoogleProvider({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
    RedditProvider({
      clientId: env.REDDIT_CLIENT_ID,
      clientSecret: env.REDDIT_CLIENT_SECRET,
      authorization: {
        params: {
          duration: 'permanent',
        },
      },
    }),
    EmailProvider({
      server: {
        host: env.EMAIL_HOST,
        port: env.EMAIL_PORT,
        auth: {
          user: env.EMAIL_USER,
          pass: env.EMAIL_PASS,
        },
      },
      sendVerificationRequest,
      from: env.EMAIL_FROM,
    }),
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, req) {
        const { username = 'bot' } = credentials || {};
        const reqToken = (req.headers?.['x-civitai-api-key'] as string) ?? '';

        // TODO: verify token here

        return { id: reqToken, username, showNsfw: false, blurNsfw: false };
      },
    }),
  ],
  pages: {
    signIn: '/login',
    error: '/login',
  },
});

const authOptions = async (req: NextApiRequest, res: NextApiResponse) => {
  if (isProduction) {
    const badCookie = getCookie('__Secure-next-auth.session-token', { req, res });
    setCookie('__Secure-next-auth.session-token', badCookie, {
      req,
      res,
      maxAge: 30 * 24 * 60 * 60,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
    deleteCookie('__Secure-next-auth.session-token.sig', { req, res });
  }

  return NextAuth(req, res, createAuthOptions(req));
};

export default authOptions;
