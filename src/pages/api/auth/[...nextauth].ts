import { PrismaAdapter } from '@next-auth/prisma-adapter';
import { User } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import NextAuth, { Session, type NextAuthOptions } from 'next-auth';
import DiscordProvider from 'next-auth/providers/discord';
import GithubProvider from 'next-auth/providers/github';
import GoogleProvider from 'next-auth/providers/google';
import RedditProvider from 'next-auth/providers/reddit';
import EmailProvider from 'next-auth/providers/email';

import { env } from '~/env/server.mjs';
import { dbWrite } from '~/server/db/client';
import { getRandomInt } from '~/utils/number-helpers';
import { sendVerificationRequest } from '~/server/auth/verificationEmail';
import { refreshToken, invalidateSession } from '~/server/utils/session-helpers';
import { getSessionUser, updateAccountScope } from '~/server/services/user.service';

const setUserName = async (email: string) => {
  try {
    const { username } = await dbWrite.user.update({
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

const useSecureCookies = env.NEXTAUTH_URL.startsWith('https://');
const cookiePrefix = useSecureCookies ? '__Secure-' : '';
const { hostname } = new URL(env.NEXTAUTH_URL);
const cookieName = `${cookiePrefix}civitai-token`;

export const createAuthOptions = (req: NextApiRequest): NextAuthOptions => ({
  adapter: PrismaAdapter(dbWrite),
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
    async signIn({ account }) {
      if (account?.provider === 'discord' && !!account.scope) await updateAccountScope(account);

      return true;
    },
    async jwt({ token, user }) {
      if (req.url === '/api/auth/session?update') {
        invalidateSession(Number(token.sub));
        const user = await getSessionUser({ userId: Number(token.sub) });
        token.user = user;
      } else {
        token.sub = Number(token.sub) as any; //eslint-disable-line
        if (user) token.user = user;
        const { deletedAt, ...restUser } = token.user as User;
        token.user = { ...restUser };
      }

      return token;
    },
    async session({ session, token }) {
      if (req.url !== '/api/auth/session?update') {
        token = await refreshToken(token);
      }
      session.user = (token.user ? token.user : session.user) as Session['user'];
      return session;
    },
  },
  // Configure one or more authentication providers
  providers: [
    DiscordProvider({
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
      authorization: {
        params: { scope: 'identify email role_connections.write' },
      },
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
  ],
  cookies: {
    sessionToken: {
      name: cookieName,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: useSecureCookies,
        domain: hostname == 'localhost' ? hostname : '.' + hostname, // add a . in front so that subdomains are included
      },
    },
  },
  pages: {
    signIn: '/login',
    error: '/login',
  },
});

const oldCookieName = `${cookiePrefix}next-auth.session-token`;
const authOptions = async (req: NextApiRequest, res: NextApiResponse) => {
  // Disabling because it seems it may be causing issues
  // const cookies = getCookies({ req, res });
  // const oldToken = cookies[oldCookieName];
  // const currentToken = cookies[cookieName];
  // if (oldToken && !currentToken) {
  //   setCookie(cookieName, oldToken, {
  //     res,
  //     req,
  //     maxAge: 30 * 24 * 60 * 60,
  //     httpOnly: true,
  //     sameSite: 'lax',
  //     path: '/',
  //     secure: useSecureCookies,
  //     domain: hostname == 'localhost' ? hostname : '.' + hostname,
  //   });
  //   deleteCookie(oldCookieName, {
  //     res,
  //     req,
  //     path: '/',
  //     secure: useSecureCookies,
  //     domain: hostname,
  //   });
  // }

  return NextAuth(req, res, createAuthOptions(req));
};

export default authOptions;
